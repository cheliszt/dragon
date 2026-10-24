import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { translateProject } from "../src/pipeline.mjs";
import { createWebServer } from "../src/web-server.mjs";
import { structureMarkdown } from "../src/markdown.mjs";
import { languageSettings } from "../src/languages.mjs";
import { readJson, writeJson, writeText, sha256 } from "../src/utils.mjs";

test("pinyin draft is downloadable before QA, survives QA failure and resumes without retranslating or resetting progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "draft-recovery-"));
  const dir = path.join(root, "projects/book");
  const env = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((k) => [k, process.env[k]]));
  let translationCalls = 0, qaFails = true, web, base;
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    let value;
    if (body.text.format.name === "terminology_candidates") value = { entries: [] };
    else if (body.text.format.name === "language_analysis") {
      value = { units: JSON.parse(body.input).map((b) => ({ block_id: b.block_id, segments: [
        { text: "ren", language: "pinyin", reason: "汉语语境" }, { text: ".", language: "en", reason: "标点" }
      ] })) };
    } else if (body.text.format.name === "translation_qa") {
      // This request happens only after the draft has been durably published.
      const response = await fetch(base + "/file?kind=chinese&download=1");
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /已保存 1\/1/);
      assert.match(text, /仁。/);
      assert.doesNotMatch(text, /缺少原拼音括注/);
      if (qaFails) { res.writeHead(401); res.end('{"error":{"message":"QA unavailable"}}'); return; }
      value = { summary: "ok", issues: [] };
    } else {
      translationCalls++;
      value = { translations: JSON.parse(body.input.split("\n\n").at(-1)).map((b) => ({ block_id: b.block_id,
        translation: "仁。", translator_notes: [], source_questions: [] })) };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }));
  });
  try {
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.OPENAI_API_KEY = "mock"; process.env.OPENAI_MODEL = "mock";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
    const config = { openai: { model: "mock", baseUrl: process.env.OPENAI_BASE_URL, stream: false, semanticQa: true, chunkMaxChars: 4500, requestAttempts: 1 } };
    await writeJson(path.join(root, "config/settings.json"), config);
    const source = structureMarkdown("ren.");
    await writeText(path.join(dir, "approved.md"), source);
    for (const file of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(dir, "00_shared", file), "test");
    await writeJson(path.join(dir, "manifest.json"), { projectId: "book", status: "source_approved",
      languages: languageSettings({ sourceLanguages: ["en", "pinyin"] }),
      source: { approvedFile: "approved.md", approvedSha256: sha256(source) } });
    web = createWebServer({ root, configLoader: async () => config });
    await new Promise((r) => web.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${web.address().port}/api/projects/book`;
    await assert.rejects(translateProject(dir, { root }), /401|QA unavailable/);
    let manifest = await readJson(path.join(dir, "manifest.json"));
    assert.equal(manifest.status, "translation_failed");
    assert.equal(manifest.openai.translatedChunks, 1);
    assert.equal(manifest.draft.translatedUnits, 1);
    assert.equal(manifest.draft.qaComplete, false);
    const draft = await readFile(path.join(dir, manifest.outputs.chinese), "utf8");
    assert.doesNotMatch(draft, /拼音待人工审核/);
    // A second interruption at the first checkpoint must not reset saved progress.
    await assert.rejects(translateProject(dir, { root, checkpoint: async () => {
      const resumed = await readJson(path.join(dir, "manifest.json"));
      assert.equal(resumed.openai.translatedChunks, 1);
      throw Object.assign(new Error("pause"), { code: "PAUSED" });
    } }), /pause/);
    assert.equal(await readFile(path.join(dir, manifest.outputs.chinese), "utf8"), draft);
    qaFails = false;
    // Policy changes must reuse already published translations, even without
    // their original request context file (an upgrade from an older release).
    await writeText(path.join(dir, '00_shared/workflow.md'), 'Numeric issues are notes. Keep completed translations.');
    await rm(path.join(dir, manifest.openai.chunkDirectory, '..', 'translation-context.json'));
    const completed = await translateProject(dir, { root });
    assert.equal(translationCalls, 1);
    assert.equal(completed.manifest.status, "completed");
    assert.equal(completed.manifest.draft.qaComplete, true);
    assert.equal(completed.manifest.openai.completedChunks, 1);
    assert.equal(completed.manifest.outputs.chinese, "06_zh/project_zh.md");
    assert.ok(!completed.report.issues.some((q) => q.category === "pinyin_review"));
  } finally {
    if (web) await new Promise((r) => { web.close(r); web.closeAllConnections(); });
    await new Promise((r) => { upstream.close(r); upstream.closeAllConnections(); });
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
