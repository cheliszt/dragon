import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createWebServer } from "../src/web-server.mjs";
import { writeReadingOutputs } from "../src/reading-outputs.mjs";
import { reviewSnapshot } from "../src/review-edits.mjs";
import { readJson, writeJson, writeText } from "../src/utils.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-edits-"));
  const dir = path.join(root, "projects/book");
  const manifest = { projectId: "book", status: "completed", source: { approvedSha256: "source-v1" } };
  const blocks = [{ block_id: "B000001", source: "A temporary life.\n\nAnother sentence.", page: 1, section: "Main text" }];
  const translations = [{ block_id: "B000001", translation: "临时性生活。\n\n另一个句子。" }];
  const report = { issues: [{ block_id: "B000001", severity: "blocking", category: "meaning", description: "误译", recommendation: "改为暂时的生活。", translation_quote: "临时性生活" }] };
  await writeReadingOutputs(dir, blocks, translations, report, manifest);
  await writeJson(path.join(dir, "manifest.json"), manifest);
  const server = createWebServer({ root, workflow: {}, configLoader: async () => ({ openai: { model: "fixture", baseUrl: "https://example.test/v1" } }), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/projects/book/`;
  const get = (action) => fetch(base + action);
  const post = (action, data) => fetch(base + action, { method: "POST", headers: { "X-Local-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(data) });
  t.after(async () => { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); });
  return { root, dir, manifest, blocks, translations, report, get, post, server };
}
async function until(check) {
  for (let i = 0; i < 150; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error("Timed out waiting for revision");
}

test("paragraph edits publish exports atomically, retain history and detect stale views", async (t) => {
  const f = await fixture(t);
  const initial = await (await f.get("review")).json();
  assert.equal(initial.model.units.length, 2);
  const unit = initial.model.units[0];
  const data = { version: initial.model.version, revision: 0, unitId: unit.id, before: unit.target, target: "暂时的生活。" };
  assert.equal((await f.post("edit", { ...data, target: "" })).status, 400);
  assert.equal((await f.post("edit", { ...data, unitId: "missing" })).status, 400);
  assert.equal((await f.post("edit", { ...data, version: "old" })).status, 409);
  const result = await (await f.post("edit", data)).json();
  assert.equal(result.edits.revision, 1);
  assert.equal(result.model.units[0].target, data.target);
  assert.deepEqual(result.model.units[0].targetMarks, []);
  assert.equal(result.model.units[1].target, initial.model.units[1].target);
  assert.equal((await f.post("edit", data)).status, 409);
  assert.equal(await (await f.get("file?kind=chinese")).text(), "暂时的生活。\n\n另一个句子。\n");
  for (const [format, mime, signature] of [
    ["docx", "wordprocessingml.document", "PK"], ["pdf", "application/pdf", "%PDF-"]
  ]) {
    const response = await f.get(`file?kind=chinese&format=${format}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), new RegExp(mime));
    assert.match(response.headers.get("content-disposition"), /attachment/);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, signature.length).toString(), signature);
  }
  assert.equal((await f.get("file?kind=bilingual&format=pdf")).status, 400);
  assert.match(await (await f.get("file?kind=bilingual")).text(), /A temporary life\.[\s\S]*暂时的生活。/);
  assert.match(await (await f.get("file?kind=bilingualHtml")).text(), /暂时的生活。/);
  assert.equal((await reviewSnapshot(f.dir)).edits.history[0].before, unit.target);
  assert.equal((await readJson(path.join(f.dir, "04_qa/review-document.json"))).units[0].target, unit.target);
  // Rebuilding the same published edition must keep its edits visible.
  await writeReadingOutputs(f.dir, f.blocks, f.translations, f.report, f.manifest);
  assert.equal((await (await f.get("review")).json()).model.units[0].target, data.target);
  const restore = { ...data, revision: 1, before: data.target, target: unit.target };
  assert.equal((await f.post("edit", restore)).status, 200);
  assert.equal((await reviewSnapshot(f.dir)).edits.history.length, 2);
  // A different edition must not inherit positional edits from the old model.
  await writeReadingOutputs(f.dir, f.blocks, [{ ...f.translations[0], translation: "新版译文。" }], f.report, f.manifest);
  const next = await reviewSnapshot(f.dir);
  assert.equal(next.edits.revision, 0);
  assert.equal(next.archivedEditions, 1);
  assert.equal(next.model.units[0].target, "新版译文。");
});

test("AI drafts are persistent previews, require explicit apply and reject stale or mismatched proposals", async (t) => {
  const f = await fixture(t, { revise: async (input) => {
    assert.equal(input.userComment, "保持学术语体");
    assert.equal(input.source, "A temporary life.");
    return { value: { translation: "暂时的生活。", explanation: "修正对 temporary life 的误读。" } };
  } });
  const initial = await (await f.get("review")).json();
  const unit = initial.model.units[0];
  const data = { version: initial.model.version, unitId: unit.id, before: unit.target, issueId: unit.issueIds[0], note: "保持学术语体" };
  assert.equal((await f.post("proposals", { ...data, issueId: "unknown" })).status, 400);
  const accepted = await (await f.post("proposals", data)).json();
  assert.ok(accepted.id);
  const p = await until(async () => (await (await f.get("proposals")).json()).proposals.find((p) => p.state === "completed"));
  assert.equal(p.translation, "暂时的生活。");
  assert.equal((await reviewSnapshot(f.dir)).model.units[0].target, unit.target);
  const apply = { ...data, revision: 0, proposalId: p.id, target: "各种暂时的生活。" };
  assert.equal((await f.post("edit", apply)).status, 200);
  const applied = await reviewSnapshot(f.dir);
  assert.equal(applied.edits.history[0].method, "ai");
  assert.equal(applied.edits.history[0].proposalId, p.id);
  assert.equal(applied.model.units[0].target, apply.target);
  assert.equal((await f.post("edit", { ...apply, revision: 1, before: apply.target })).status, 409);
  assert.equal((await f.post("proposals", data)).status, 409);
  // Failure is surfaced as a failed draft, never as a modified manuscript.
  const failed = await fixture(t, { revise: async () => { throw new Error("mock capacity error"); } });
  const before = await (await failed.get("review")).json();
  assert.equal((await failed.post("proposals", { ...data, version: before.model.version })).status, 202);
  const failure = await until(async () => (await (await failed.get("proposals")).json()).proposals.find((p) => p.state === "failed"));
  assert.match(failure.error, /mock capacity/);
  assert.equal((await reviewSnapshot(failed.dir)).edits.revision, 0);
});

test("detached AI revision survives web shutdown and calls the configured Responses endpoint", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let called = false;
  const api = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); assert.equal(req.url, "/v1/responses"); assert.equal(data.text.format.name, "paragraph_revision");
    called = true; await gate;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "mock", status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ translation: "暂时的生活。", explanation: "依据原文修订。" }) }] }] }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(async () => { release(); await new Promise((r) => { api.close(r); api.closeAllConnections(); }); });
  const f = await fixture(t);
  await writeJson(path.join(f.root, "config/settings.json"), { openai: { model: "mock", baseUrl: `http://127.0.0.1:${api.address().port}/v1`, stream: false } });
  await writeText(path.join(f.root, ".env"), `OPENAI_API_KEY=local-test\nOPENAI_BASE_URL=http://127.0.0.1:${api.address().port}/v1\nOPENAI_MODEL=mock\n`);
  for (const file of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(f.dir, "00_shared", file), "Test instructions.");
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = "local-test"; process.env.OPENAI_BASE_URL = `http://127.0.0.1:${api.address().port}/v1`; process.env.OPENAI_MODEL = "mock";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const initial = await (await f.get("review")).json(), unit = initial.model.units[0];
  const accepted = await (await f.post("proposals", { version: initial.model.version, unitId: unit.id, before: unit.target, issueId: unit.issueIds[0], note: "" })).json();
  await until(() => called);
  await new Promise((r) => { f.server.close(r); f.server.closeAllConnections(); });
  release();
  const p = await until(async () => { const value = await readJson(path.join(f.dir, "04_qa/proposals", `${accepted.id}.json`)); return value.state === "completed" && value; });
  assert.equal(p.translation, "暂时的生活。");
  assert.equal((await reviewSnapshot(f.dir)).edits.revision, 0);
});
