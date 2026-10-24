import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfText, assessTextPages, selectedPages } from "../src/pdf-text.mjs";
import { prepareSource, approveSource, runOcr } from "../src/pipeline.mjs";
import { findSourceIssues, resolveSourceIssue } from "../web/source-issues.js";

const paragraph = "Literature is read in context. Translation requires attention to history, language, and the structure of each argument. ";

test("text-layer quality rejects page numbers, sparse scans, and corrupt text", () => {
  assert.equal(assessTextPages([{ page: 1, text: "42" }]).suitable, false);
  assert.equal(assessTextPages([{ page: 1, text: paragraph.repeat(3) + "\uFFFD".repeat(50) }]).suitable, false);
  assert.equal(assessTextPages([{ page: 1, text: paragraph.repeat(3) }, { page: 2, text: "" }]).suitable, false);
  assert.deepEqual(selectedPages("3,1-2,2", 4), [1, 2, 3]);
  assert.throws(() => selectedPages("0-2", 4));
  assert.throws(() => selectedPages("1-8", 4));
});

test("local extraction preserves page references and uses the existing approval gate without network", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pdf-text-test-"));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.PADDLEOCR_ACCESS_TOKEN;
  process.env.PADDLEOCR_ACCESS_TOKEN = "";
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("Unexpected network call"); };
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 10; i += 1) {
      const page = pdf.addPage([500, 700]);
      page.drawText(i === 9 ? "10" : paragraph, { x: 30, y: 650, size: 10, font, maxWidth: 430 });
    }
    const file = path.join(temp, "text.pdf");
    await writeFile(file, await pdf.save());
    const extracted = await extractPdfText(file);
    assert.equal(extracted.report.suitable, true);
    assert.equal(extracted.report.totalPages, 10);
    assert.deepEqual(extracted.report.reviewPages, [10]);
    assert.match(extracted.markdown, /pdf_page: 10/);
    assert.match(extracted.markdown, /CHECK-SOURCE/);
    const project = await prepareSource(file, { projectsDir: path.join(temp, "projects") });
    assert.equal(project.manifest.preparation.method, "text");
    assert.equal(project.manifest.status, "source_review_required");
    assert.equal(project.manifest.paddle.jobId, undefined);
    assert.equal(requests, 0);
    await assert.rejects(approveSource(project.projectDir), /未决标记/);
    const candidate = path.join(project.projectDir, project.manifest.source.candidateFile);
    const text = await readFile(candidate, "utf8");
    const issues = findSourceIssues(text);
    assert.deepEqual(issues.map((issue) => issue.page), [10]);
    await writeFile(candidate, resolveSourceIssue(text, issues[0]));
    const approved = await approveSource(project.projectDir);
    assert.equal(approved.status, "source_approved");
    assert.ok(approved.source.approvedSha256);
    const subset = await extractPdfText(file, { pageRanges: "2-3" });
    assert.equal(subset.report.inspectedPages, 2);
    assert.match(subset.markdown, /pdf_page: 2/);
    assert.doesNotMatch(subset.markdown, /pdf_page: 1/);

    const sparse = await PDFDocument.create();
    sparse.addPage().drawText("1");
    const sparsePath = path.join(temp, "sparse.pdf");
    await writeFile(sparsePath, await sparse.save());
    await assert.rejects(prepareSource(sparsePath, { projectsDir: path.join(temp, "sparse-projects") }), /PADDLEOCR_ACCESS_TOKEN/);
    assert.equal(requests, 0);
    const dirs = await readdir(path.join(temp, "sparse-projects"));
    const failed = JSON.parse(await readFile(path.join(temp, "sparse-projects", dirs[0], "manifest.json")));
    assert.equal(failed.preparation.method, "ocr");
    assert.equal(failed.status, "ocr_failed");

    process.env.PADDLEOCR_ACCESS_TOKEN = "dummy-token";
    globalThis.fetch = async (_url, options) => {
      requests += 1;
      assert.equal(options.body.get("file").type, "application/pdf");
      return Response.json({ message: "file cannot be parsed" }, { status: 400, headers: { "x-request-id": "test-request" } });
    };
    await assert.rejects(runOcr(file, { projectsDir: path.join(temp, "forced-projects") }), /HTTP 400/);
    assert.equal(requests, 1);
    const forcedDirs = await readdir(path.join(temp, "forced-projects"));
    const diagnostic = JSON.parse(await readFile(path.join(temp, "forced-projects", forcedDirs[0], "04_qa/ocr-error.json")));
    assert.equal(diagnostic.attempts.length, 1);
    assert.equal(diagnostic.attempts[0].requestId, "test-request");
    assert.doesNotMatch(JSON.stringify(diagnostic), /dummy-token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.PADDLEOCR_ACCESS_TOKEN;
    else process.env.PADDLEOCR_ACCESS_TOKEN = previousToken;
    await rm(temp, { recursive: true, force: true });
  }
});
