import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createWebServer } from "../src/web-server.mjs";
import { approveSource } from "../src/pipeline.mjs";
import { withTranslationLock } from "../src/translation-lock.mjs";
import { readJson, writeJson, writeText } from "../src/utils.mjs";
import { PDFDocument } from "pdf-lib";

test("local web workflow uploads, reviews, approves, downloads, and restricts access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "translation-web-test-"));
  const id = "20260917-test";
  const dir = path.join(root, "projects", id);
  const sourceFile = "02_source_candidates/reconciled/document.md";
  const source = "<!-- block_id: B000001 -->\n\nAn example text.\n";
  let finishOcr;
  const ocrGate = new Promise((resolve) => { finishOcr = resolve; });
  const previous = { paddle: process.env.PADDLEOCR_ACCESS_TOKEN, openai: process.env.OPENAI_API_KEY };
  process.env.PADDLEOCR_ACCESS_TOKEN = "test-paddle-secret";
  process.env.OPENAI_API_KEY = "test-openai-secret";
  const workflow = {
    async prepareSource(file, { onProjectCreated, mode }) {
      assert.equal(mode, "text");
      const manifest = { projectId: id, status: "ocr_running", createdAt: new Date().toISOString(), source: { originalFile: "01_source_original/document.pdf" } };
      await writeText(path.join(dir, manifest.source.originalFile), await readFile(file));
      await writeJson(path.join(dir, "manifest.json"), manifest);
      await onProjectCreated(dir);
      await ocrGate;
      await writeText(path.join(dir, sourceFile), source);
      manifest.status = "source_review_required";
      manifest.source.candidateFile = sourceFile;
      await writeJson(path.join(dir, "manifest.json"), manifest);
    },
    approveSource,
    async translateProject(projectDir) {
      const manifest = await readJson(path.join(projectDir, "manifest.json"));
      assert.ok(["source_approved", "translation_failed", "translating"].includes(manifest.status));
      assert.equal(await readFile(path.join(projectDir, manifest.source.approvedFile), "utf8"), source.replace("example", "corrected"));
      await writeText(path.join(projectDir, "06_zh/project_zh.md"), "示例译文");
      manifest.status = "completed";
      manifest.outputs = { chinese: "06_zh/project_zh.md" };
      await writeJson(path.join(projectDir, "manifest.json"), manifest);
    }
  };
  const configLoader = async () => ({ openai: { model: "test-model", baseUrl: "https://relay.example.test/v1" } });
  let server = createWebServer({ root, configLoader, workflow });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const get = (url) => fetch(base + url);
  const post = (url, body, extra = {}) => fetch(base + url, { method: "POST", headers: { "X-Local-Request": "1", ...extra }, body });
  const state = async () => (await get("/api/state")).json();
  async function until(predicate) {
    for (let i = 0; i < 100; i += 1) {
      const current = await state();
      if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Workflow did not reach expected state: ${JSON.stringify(await state())}`);
  }
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  try {
    assert.match(await (await get("/")).text(), /文献识别与翻译/);
    for (const asset of ["/source-issues.js", "/source-review.js", "/task-state.js"]) {
      const response = await get(asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/javascript/);
    }
    assert.equal((await get("/.env")).status, 404);
    const foreignHostStatus = await new Promise((resolve, reject) => {
      http.get(base + "/api/state", { headers: { Host: "evil.example" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await post("/api/upload", "%PDF-test", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(base + "/api/upload", { method: "POST", body: "%PDF-test" })).status, 403);
    assert.equal((await post("/api/upload", "not a PDF")).status, 400);
    assert.equal((await post("/api/upload", "%PDF-test", { "X-File-Name": "invalid.txt" })).status, 400);
    assert.equal((await post("/api/upload", "%PDF-1.4", { "X-Source-Mode": "invalid" })).status, 400);
    delete process.env.PADDLEOCR_ACCESS_TOKEN;
    assert.equal((await post("/api/upload", "%PDF-1.4", { "X-Source-Mode": "ocr" })).status, 400);
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("An example text.");
    assert.equal((await post("/api/upload", await pdf.save(), { "X-File-Name": encodeURIComponent("文献.pdf"), "X-Source-Mode": "text" })).status, 202);
    process.env.PADDLEOCR_ACCESS_TOKEN = "test-paddle-secret";
    await until((s) => s.active?.projectId === id);
    assert.equal((await post("/api/upload", "%PDF-1.4")).status, 409);
    finishOcr();
    const ready = await until((s) => !s.active && s.projects[0]?.status === "source_review_required");
    assert.ok(ready.config.paddleReady && ready.config.translationReady);
    assert.doesNotMatch(JSON.stringify(ready), /test-paddle-secret|test-openai-secret/);
    assert.equal((await (await get(`/api/projects/${id}/source`)).json()).text, source);
    assert.equal((await post(`/api/projects/${id}/source`, "deleted identifiers")).status, 400);
    assert.equal((await post(`/api/projects/${id}/source`, source.replace("example", "corrected"))).status, 200);
    await withTranslationLock(dir, async () => {
      assert.equal((await state()).active.projectId, id);
      assert.equal((await post(`/api/projects/${id}/translate`)).status, 409);
    }, { root });
    assert.equal((await post(`/api/projects/${id}/translate`)).status, 202);
    await until((s) => !s.active && s.projects[0]?.status === "completed");
    const normalizedSource = (await (await get(`/api/projects/${id}/source`)).json()).text;
    assert.match(normalizedSource, /block_id: U000001/);
    assert.match(normalizedSource, /An corrected text\./);
    assert.equal(await (await get(`/api/projects/${id}/file?kind=source`)).text(), normalizedSource);
    assert.equal((await post(`/api/projects/${id}/source`, source)).status, 409);
    assert.equal((await post(`/api/projects/${id}/translate`)).status, 409);
    const output = await get(`/api/projects/${id}/file?kind=chinese&download=1`);
    assert.match(output.headers.get("content-disposition"), /attachment/);
    assert.equal(await output.text(), "示例译文");
    assert.equal((await get(`/api/projects/${id}/file?kind=../../.env`)).status, 404);
    assert.equal((await get("/api/projects/..%5C..%5C/source")).status, 400);
    await writeJson(path.join(dir, "04_qa/review-document.json"), { version: "reading-v1", issues: [{ id: "q-1" }], units: [{ blockId: "B000001" }] });
    const reviewUrl = `/api/projects/${id}/review`;
    const review = await (await get(reviewUrl)).json();
    assert.equal(review.revision, 0);
    const decision = { version: "reading-v1", revision: 0, issues: { "q-1": { status: "reviewed", note: "已对照原页" } }, scopes: { B000001: "body" } };
    assert.equal((await post(reviewUrl, JSON.stringify(decision))).status, 200);
    assert.equal((await post(reviewUrl, JSON.stringify(decision))).status, 409);
    assert.equal((await post(reviewUrl, JSON.stringify({ ...decision, revision: 1, version: "old" }))).status, 409);
    assert.equal((await post(reviewUrl, JSON.stringify({ ...decision, revision: 1, issues: { unknown: { status: "reviewed" } } }))).status, 400);
    assert.equal((await (await get(reviewUrl)).json()).state.issues['q-1'].note, "已对照原页");
    const manifest = await readJson(path.join(dir, "manifest.json"));
    manifest.source.originalFile = "../../private.txt";
    await writeText(path.join(root, "private.txt"), "private");
    await writeJson(path.join(dir, "manifest.json"), manifest);
    assert.equal((await get(`/api/projects/${id}/file?kind=original`)).status, 403);
    manifest.source.originalFile = "01_source_original/document.pdf";
    manifest.status = "translating";
    await writeJson(path.join(dir, "manifest.json"), manifest);
    await close();
    server = createWebServer({ root, configLoader, workflow });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await get(reviewUrl)).json()).state.issues['q-1'].status, "reviewed");
    assert.equal((await state()).projects[0].id, id);
    assert.equal((await post(`/api/projects/${id}/translate`)).status, 202);
    await until((s) => !s.active && s.projects[0]?.status === "completed");
    workflow.translateProject = async () => { throw new Error("Simulated API failure"); };
    manifest.status = "translation_failed";
    await writeJson(path.join(dir, "manifest.json"), manifest);
    assert.equal((await post(`/api/projects/${id}/translate`)).status, 202);
    const failed = await until((s) => !s.active && s.lastError);
    assert.equal(failed.lastError.message, "Simulated API failure");
  } finally {
    finishOcr();
    await close();
    if (previous.paddle === undefined) delete process.env.PADDLEOCR_ACCESS_TOKEN;
    else process.env.PADDLEOCR_ACCESS_TOKEN = previous.paddle;
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
    await rm(root, { recursive: true, force: true });
  }
});
