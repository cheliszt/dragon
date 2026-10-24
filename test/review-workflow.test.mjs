import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { reviewMatches } from "../web/review.js";
import { extractAuthorTerminology, terminologyContext } from "../src/author-terminology.mjs";
import { structureMarkdown, parseStructuredMarkdown } from "../src/markdown.mjs";
import { writeJson, writeText } from "../src/utils.mjs";
import { applyReviewEdit, reviewSnapshot } from "../src/review-edits.mjs";
import { reviewCurrentDraft } from "../src/review-qa-jobs.mjs";
import { OpenAIClient } from "../src/openai-client.mjs";
import { renderReviewHtml } from "../src/reading-outputs.mjs";
import { createWebServer } from "../src/web-server.mjs";

test("field search enumerates every occurrence, preserves exact offsets, and treats syntax literally", () => {
  const u = { id: "u1", source: "Coworker, coworkers, coworker. C++ is not C+.", target: "同事（coworker）。同事。",
    authorNotes: [{ noteId: "n1", note: { source: "Coworker in a note.", translation: "术语同事。" } }], translatorNotes: [{ id: "t1", text: "译者解释 coworker。" }] };
  assert.equal(reviewMatches(u, "coworker", "source").length, 3);
  assert.equal(reviewMatches(u, "coworker", "source", true).length, 2);
  assert.equal(reviewMatches(u, "同事", "target").length, 2);
  assert.equal(reviewMatches(u, "coworker", "notes").length, 2);
  assert.equal(reviewMatches(u, "coworker", "all").length, 6);
  const hit = reviewMatches(u, "C++", "source")[0];
  assert.equal(u.source.slice(hit.start, hit.end), "C++");
  assert.equal(reviewMatches(u, "[", "source").length, 0);
});

test("author glossary detection ignores TOC, retains page provenance, and joins continuing definitions", () => {
  const text = "CONTENTS\n\nGlossary of Concepts 91\n\n1 Introduction\n\nNo glossary yet.\n\n<!-- pdf_page: 18 -->\n\nGLOSSARY OF CONCEPTS\n\nconcept A useful concept.\n\ncoworker A social type, not an ordinary colleague.\n\n<!-- pdf_page: 19 -->\n\nwho will tell stories on Monday.\n\nNOTES\n\n1 This is an endnote.";
  const c = extractAuthorTerminology(parseStructuredMarkdown(structureMarkdown(text)));
  assert.equal(c.sections.length, 1); assert.equal(c.entries.length, 2);
  assert.equal(c.entries[0].term, "concept"); assert.equal(c.entries[1].page, 18);
  assert.match(c.entries[1].definition, /Monday/); assert.doesNotMatch(c.entries[1].definition, /endnote/);
  assert.equal(terminologyContext(c, [{ block_id: "u1", source: "These coworkers arrived." }]).firstUses[1].firstBlockId, "u1");
  const cn = extractAuthorTerminology(parseStructuredMarkdown(structureMarkdown("术语表\n\n黑性：这里的专门词义。\n\n参考文献\n\nA book.")));
  assert.equal(cn.entries[0].term, "黑性");
  const no = extractAuthorTerminology(parseStructuredMarkdown(structureMarkdown("This book mentions a glossary, but has no section.")));
  assert.equal(no.detected, false); assert.equal(no.entries.length, 0);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-current-")), dir = path.join(root, "projects/book");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, "config/settings.json"), { openai: { chunkMaxChars: 3000 }, translation: { targetLanguage: "简体中文" } });
  for (const name of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(dir, "00_shared", name), "Test style");
  await writeJson(path.join(dir, "manifest.json"), { source: {} });
  const model = { version: "revision-test", sourceHash: "s", issues: [{ id: "q1", severity: "warning", description: "旧意见", recommendation: "旧改法", blockIds: ["U000001"] }], units: [
    { id: "u1", blockId: "U000001", source: "A coworker arrives.", target: "一个同事来了。", section: "正文", scope: "body", issueIds: ["q1"], sourceMarks: [], targetMarks: [] },
    { id: "u2", blockId: "U000002", source: "No issue here.", target: "这里没有问题。", section: "正文", scope: "body", issueIds: [], sourceMarks: [], targetMarks: [] }
  ] };
  await writeJson(path.join(dir, "04_qa/review-document.json"), model);
  const edit = async (unitId, target) => { const s = await reviewSnapshot(dir); return applyReviewEdit(dir, { version: model.version, revision: s.edits.revision, unitId,
    before: s.model.units.find((u) => u.id === unitId).target, target }, { root }); };
  return { root, dir, model, edit };
}

test("all units are editable; QA is tied to current human text and detects edits made during AI review", async (t) => {
  const f = await fixture(t);
  let s = await f.edit("u2", "这段没有 AI 问题，也可人工修订。");
  assert.equal(s.model.units[1].qa.state, "stale");
  await f.edit("u1", "一个“同事”（coworker）来了。");
  let calls = 0;
  const client = { model: "fixture", baseUrl: "local", review: async (blocks, translations, context) => {
    calls++;
    assert.equal(context.humanRevision, 2);
    assert.equal(translations[0].translation, "一个“同事”（coworker）来了。");
    // This succeeds while the AI request is pending. AI results cannot overwrite it.
    await f.edit("u1", "一个“同事”（coworker）来到了这里。");
    return { value: { issues: [{ severity: "warning", category: "term", block_id: "u1", description: "仅检查本次快照", recommendation: "核对", source_quote: "coworker", translation_quote: "同事" }] } };
  } };
  s = await reviewCurrentDraft(f.dir, { root: f.root, runId: "first", client });
  assert.equal(calls, 1); assert.equal(s.edits.revision, 3);
  assert.equal(s.model.units[0].target, "一个“同事”（coworker）来到了这里。");
  assert.equal(s.model.units[0].qa.state, "stale"); assert.equal(s.model.units[0].qa.basisRevision, 2);
  assert.equal(s.model.units[1].qa.state, "current");
  assert.equal(s.model.units[1].issueIds.length, 0);
  assert.ok(s.model.issues.find((q) => q.description === "仅检查本次快照").stale);
  s = await reviewCurrentDraft(f.dir, { root: f.root, runId: "second", client: { ...client, review: async (blocks, translations) => {
    assert.equal(blocks.length, 1); assert.match(translations[0].translation, /来到了这里/); return { value: { issues: [] } };
  } } });
  assert.equal(s.model.units[0].qa.state, "current"); assert.equal(s.model.units[0].qa.basisRevision, 3);
  assert.equal(s.model.units[0].issueIds.length, 0); assert.equal(s.edits.revision, 3);
  assert.equal(JSON.parse(await readFile(path.join(f.dir, "04_qa/review-document.json"), "utf8")).units[0].target, f.model.units[0].target);
});

test("recheck API rejects stale snapshots and reads latest edits on both views", async (t) => {
  const f = await fixture(t);
  const server = createWebServer({ root: f.root, workflow: {}, reviewDraft: (dir, opts) => reviewCurrentDraft(dir, { ...opts,
    client: { model: "fixture", baseUrl: "local", review: async () => ({ value: { issues: [] } }) } }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/projects/book/`;
  const post = (data) => fetch(base + "recheck", { method: "POST", headers: { "X-Local-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(data) });
  await f.edit("u2", "人工新译文。");
  assert.equal((await post({ version: f.model.version, revision: 0, mode: "all" })).status, 409);
  assert.equal((await post({ version: f.model.version, revision: 1, mode: "all", unitIds: ["missing"] })).status, 400);
  assert.equal((await post({ version: f.model.version, revision: 1, mode: "changed" })).status, 200);
  const result = await (await fetch(base + "review")).json();
  assert.equal(result.model.units[1].target, "人工新译文。");
  assert.equal(result.model.units[1].qa.state, "current");
  assert.equal(result.edits.revision, 1);
});

test("translation, revision and QA prompts receive author definitions and contextual term policy", async () => {
  const client = new OpenAIClient({ model: "fixture", apiKey: "unused" });
  const requests = [];
  client.structuredRequest = async (name, schema, instructions, input) => { requests.push({ name, instructions, input }); return { value: { issues: [] } }; };
  const context = { targetLanguage: "中文", authorTerminology: { entries: [{ term: "coworker", definition: "A specific nonraver." }] } };
  await client.translate([{ block_id: "u1", source: "A coworker." }], context);
  await client.review([], [], context); await client.revise({ source: "A coworker." }, context);
  for (const r of requests) {
    assert.match(r.instructions, /全书默认严格统一/);
    assert.match(r.instructions, /每一次例外都必须/);
    assert.match(r.instructions + r.input, /A specific nonraver/);
    assert.match(r.instructions, /人工核准/); assert.match(r.instructions, /括号中的非汉语原词/);
    assert.match(r.instructions, /汉语拼音及汉语专名罗马化只写核实后的简体字，不附原拼音/);
    assert.match(r.instructions, /普通民众姓名可直接保留完整拼音/);
  }
  const html = await renderReviewHtml({ version: "v", title: "测试", issues: [], units: [] });
  assert.match(html, /function reviewMatches/);
});
