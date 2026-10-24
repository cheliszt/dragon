import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractAuthorNotes, buildAnnotations, attachAnnotations, annotatedMarkdown, annotationParagraphs, annotationText, rebaseAnnotations } from "../src/annotations.mjs";
import { validateAlignment, sourceParagraphs } from "../src/annotation-jobs.mjs";
import { annotationDirectory } from "../src/annotation-store.mjs";
import { applyAnnotationEdit, reviewSnapshot, applyReviewEdit } from "../src/review-edits.mjs";
import { writeJson, readJson } from "../src/utils.mjs";
import { detectPdfFootnotes } from "../src/pdf-text.mjs";
import { createWebServer } from "../src/web-server.mjs";

const block = (id, source, target, section = "正文") => ({ id, blockId: id, source, target, section, scope: "body", issueIds: [], sourceMarks: [], targetMarks: [] });
const markdown = '1 First Chapter\n\nA thought (here).1 Another sentence.\n\n2 Second Chapter\n\nA different thought.1\n\nNOTES\n\n1. First Chapter\n\n1 First note.\n   A continuation.\n\n2. Second Chapter\n\n1 Different note.\n\nREFERENCES\n\n1 Not a note.';
const model = { version: "notes-v1", sourceHash: "source", issues: [], units: [block("h1", "1 First Chapter", "第一章"),
  block("u1", "A thought (here).1 Another sentence.", "这是人工修订好的句子。另一句话。"),
  block("h2", "2 Second Chapter", "第二章"), block("u2", "A different thought.1", "不同的观点。1"),
  block("notes", "NOTES", "注释", "注释与附录"), block("n1", "1. First Chapter", "第一章", "注释与附录"),
  block("n2", "1 First note. A continuation.", "1 第一条注释。补充。", "注释与附录"),
  block("n3", "2. Second Chapter", "第二章", "注释与附录"), block("n4", "1 Different note.", "1 不同的注释。", "注释与附录") ] };

test("endnotes with chapter resets retain full source and use chapter plus label identity", () => {
  const extracted = extractAuthorNotes(markdown);
  assert.equal(extracted.notes.length, 2);
  assert.equal(extracted.notes[0].source, "First note. A continuation.");
  const c = buildAnnotations(markdown, model);
  assert.equal(c.references.length, 2);
  assert.equal(c.unresolved.length, 0);
  assert.notEqual(c.references[0].noteId, c.references[1].noteId);
  assert.equal(c.notes[0].translation, "第一条注释。补充。");
  assert.equal(c.notes[1].translation, "不同的注释。");
});

test("short numbered notes are not mistaken for chapter headings", () => {
  const c = extractAuthorNotes('A paragraph.1\n\nNOTES\n\n1. A short note.\n\n2. Another note.');
  assert.equal(c.notes.length, 2);
  assert.equal(c.chapters.length, 0);
  assert.equal(c.notes[0].source, "A short note.");
});

test("Markdown footnote definitions and mid-sentence references are linked without interpreting numbers as notes", () => {
  const text = 'In 2021, a term[^term] needs explanation.\n\n[^term]: An author explanation.\n    Its continuation.';
  const m = { ...model, units: [block("u1", "In 2021, a term[^term] needs explanation.", "一个术语需要解释。") ] };
  const c = buildAnnotations(text, m);
  assert.equal(c.notes.length, 1);
  assert.equal(c.references.length, 1);
  assert.equal(c.references[0].label, "term");
  assert.match(c.notes[0].source, /continuation/);
});

test("page footnotes use smaller type and page provenance, including repeated labels", () => {
  const item = (str, x, y, height) => ({ str, transform: [height, 0, 0, height, x, y], height, width: str.length * height * 0.4, hasEOL: true });
  const pages = [1, 2].map((page) => ({ page, view: [0, 0, 600, 800], items: [
    item("A long main paragraph describing the history of literature and interpretation and a particular social context.1", 60, 650, 12),
    item(`1 An author footnote specific to page ${page}, with enough words to explain the argument.`, 60, 110, 8)
  ] }));
  const footnotes = detectPdfFootnotes(pages);
  assert.equal(footnotes.length, 2);
  const m = { ...model, units: pages.map((p) => ({ ...block(`u${p.page}`, p.items[0].str, "正文。1"), page: p.page })) };
  const c = buildAnnotations("Main text.", m, { footnotes });
  assert.equal(c.references.length, 2);
  assert.notEqual(c.references[0].noteId, c.references[1].noteId);
  assert.match(c.references[0].noteId, /page-1/);
});

function alignedCatalog() {
  const c = buildAnnotations(markdown, model);
  const u = model.units[1], refs = c.references.filter((r) => r.unitId === u.id);
  const parts = sourceParagraphs(u, ["A thought (here).1", "Another sentence."]);
  // Short exact paragraph boundaries are valid too, supplied by the source structure.
  const end = u.source.indexOf(" Another");
  const paragraphs = [{ id: "p1", sourceStart: 0, sourceEnd: end }, { id: "p2", sourceStart: end, sourceEnd: u.source.length }];
  const value = { references: [{ id: refs[0].id, quote: "这是人工修订好的句子。" }],
    paragraphs: [{ id: "p1", quote: "这是人工修订好的句子。" }, { id: "p2", quote: "另一句话。" }] };
  const aligned = validateAlignment(u, refs, paragraphs, value);
  c.references[0].targetQuote = aligned.references[0].targetQuote;
  c.references[1].targetQuote = "不同的观点。";
  c.paragraphMaps.u1 = { paragraphs: aligned.paragraphs };
  return c;
}

test("annotation output restores only markers and puts translated notes after each natural paragraph", () => {
  const m = attachAnnotations(model, alignedCatalog());
  assert.equal(m.units[1].target, model.units[1].target);
  const text = annotatedMarkdown(m);
  assert.match(text, /人工修订好的句子。\[1\][\s\S]*作者原注 1[\s\S]*第一条注释。补充。[\s\S]*另一句话。/);
  assert.doesNotMatch(text, /观点。\[1\]1/);
  assert.equal(annotationText(m.units[1].target, m.units[1].authorNotes).replace("[1]", ""), model.units[1].target);
  assert.equal(annotationParagraphs(m.units[1]).length, 2);
});

test("source note placement preserves original endnotes and callouts without paragraph duplicates", () => {
  const m = attachAnnotations(model, alignedCatalog(), { revision: 1, authorNotePlacement: "source", notes: {}, translatorNotes: [
    { unitId: "u1", paragraphId: "p1", text: "保留译者说明。" }
  ] });
  for (const bilingual of [false, true]) {
    const text = annotatedMarkdown(m, { bilingual });
    assert.doesNotMatch(text, /作者原注/);
    assert.equal(text.split("第一条注释。补充。").length - 1, 1);
    assert.equal(text.split("不同的注释。").length - 1, 1);
    assert.match(text, /人工修订好的句子。\[1\]/);
    assert.match(text, /保留译者说明/);
  }
  assert.deepEqual(m.units.map(u => u.target), model.units.map(u => u.target));
  assert.ok(m.units.flatMap(u => u.authorNotes).every(r => r.inlineNote === false));
});

test("adding an original-term parenthesis retains natural paragraphs and their note anchors", () => {
  const before = model.units[1].target;
  const target = before.replace("人工修订", "人工修订（revision）");
  const c = rebaseAnnotations(alignedCatalog(), "u1", before, target);
  const next = attachAnnotations({ ...model, units: model.units.map((u) => u.id === "u1" ? { ...u, target } : u) }, c);
  const u = next.units[1];
  assert.equal(annotationParagraphs(u).length, 2);
  assert.equal(u.authorNotes[0].targetOffset, target.indexOf("另一句话"));
  assert.equal(u.annotationNeedsAlignment, false);
  assert.equal(u.target, target);
});

test("AI placement must copy unique quotes, cover the target, and stay within its source paragraph", () => {
  const u = model.units[1];
  const refs = [{ id: "r1", sourceStart: 15 }];
  const parts = [{ id: "p1", sourceStart: 0, sourceEnd: 17 }, { id: "p2", sourceStart: 17, sourceEnd: u.source.length }];
  const value = { references: [{ id: "r1", quote: "改写了正文。" }], paragraphs: [{ id: "p1", quote: "这是人工修订好的句子。" }, { id: "p2", quote: "另一句话。" }] };
  assert.throws(() => validateAlignment(u, refs, parts, value), /不存在/);
  value.references[0].quote = "另一句话。";
  assert.throws(() => validateAlignment(u, refs, parts, value), /超出/);
});

test("paragraph boundaries retain closing quotes and existing author markers without duplicating them", () => {
  const source = 'An author says, "This is the end."1 Another paragraph.2';
  const target = '作者说：“这里是结尾。”[1]另一个自然段。2';
  const unit = block("quoted", source, target);
  const first = source.indexOf("1"), second = source.lastIndexOf("2");
  const refs = [{ id: "r1", label: "1", sourceStart: first, sourceEnd: first + 1 },
    { id: "r2", label: "2", sourceStart: second, sourceEnd: second + 1 }];
  const parts = sourceParagraphs(unit, [source.slice(0, first + 1), source.slice(first + 1).trim()]);
  assert.equal(parts.length, 2);
  const value = { references: [{ id: "r1", quote: "另一个自然段。" }, { id: "r2", quote: "另一个自然段。" }],
    paragraphs: [{ id: "p1", quote: "这里是结尾。" }, { id: "p2", quote: "另一个自然段。" }] };
  const aligned = validateAlignment(unit, refs, parts, value);
  assert.equal(aligned.paragraphs[0].targetOffset, target.indexOf("另一个"));
  assert.equal(aligned.paragraphs[1].targetOffset, target.length);
  assert.equal(aligned.references[0].targetOffset, target.indexOf("[1]"));
  assert.equal(unit.target, target);
});

test("author-note and translator-note edits persist independently and never overwrite human body edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "annotation-edit-"));
  const dir = path.join(root, "projects/book");
  try {
    await writeJson(path.join(dir, "manifest.json"), { source: {} });
    await writeJson(path.join(dir, "04_qa/review-document.json"), model);
    const folder = annotationDirectory(dir, model.version);
    await writeJson(path.join(folder, "catalog.json"), alignedCatalog());
    const author = { version: model.version, revision: 0, kind: "author", noteId: "author-chapter-1-1", source: "First note. A continuation.", translation: "校订后的原注译文。" };
    let saved = await applyAnnotationEdit(dir, author, { root });
    assert.equal(saved.model.annotations.revision, 1);
    assert.equal(saved.model.units[1].target, model.units[1].target);
    assert.equal(saved.model.units[1].authorNotes[0].note.translation, author.translation);
    await assert.rejects(applyAnnotationEdit(dir, author, { root }), /另一窗口/);
    saved = await applyAnnotationEdit(dir, { version: model.version, revision: 1, kind: "translator", unitId: "u1", paragraphId: "p1", text: "译者补充：此处有语境差异。" }, { root });
    assert.equal(saved.model.units[1].translatorNotes.length, 1);
    assert.match(annotatedMarkdown(saved.model), /译者补充/);
    const body = await applyReviewEdit(dir, { version: model.version, revision: 0, unitId: "u1", before: model.units[1].target, target: model.units[1].target + "补充正文。" }, { root });
    assert.equal(body.model.units[1].translatorNotes.length, 1);
    assert.equal(body.model.units[1].authorNotes[0].note.translation, author.translation);
    const reloaded = await reviewSnapshot(dir);
    assert.equal(reloaded.model.annotations.revision, 2);
    assert.equal((await readJson(path.join(dir, "04_qa/review-document.json"))).units[1].target, model.units[1].target);
    const id = saved.model.units[1].translatorNotes[0].id;
    const removed = await applyAnnotationEdit(dir, { version: model.version, revision: 2, kind: "translator", noteId: id, unitId: "u1", paragraphId: "p1", delete: true }, { root });
    assert.equal(removed.model.units[1].translatorNotes.length, 0);
    assert.equal((await readJson(path.join(folder, "current.json"))).history.length, 3);
    assert.equal(removed.model.units[1].target, model.units[1].target + "补充正文。");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("web note edits and all download formats share the latest annotation revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "annotation-web-"));
  const dir = path.join(root, "projects/book");
  const server = createWebServer({ root, workflow: {}, configLoader: async () => ({ openai: { model: "fixture", baseUrl: "https://fixture.invalid" } }) });
  try {
    await writeJson(path.join(dir, "manifest.json"), { source: {}, status: "completed" });
    await writeJson(path.join(dir, "04_qa/review-document.json"), model);
    await writeJson(path.join(annotationDirectory(dir, model.version), "catalog.json"), alignedCatalog());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/projects/book/`;
    const post = (data) => fetch(base + "annotations", { method: "POST", headers: { "X-Local-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(data) });
    let response = await post({ version: model.version, revision: 0, kind: "author", noteId: "author-chapter-1-1", source: "An edited author source.", translation: "网页校订的原注。" });
    assert.equal(response.status, 200);
    response = await post({ version: model.version, revision: 1, kind: "translator", unitId: "u1", paragraphId: "p1", text: "网页新增译注。" });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.model.units[1].target, model.units[1].target);
    assert.equal((await post({ version: model.version, revision: 2, kind: "translator", unitId: "u1", paragraphId: "p999", text: "位置不应被接受" })).status, 400);
    const chinese = await fetch(base + "file?kind=chinese&download=1");
    assert.match(chinese.headers.get("content-disposition"), /attachment/);
    assert.match(await chinese.text(), /网页校订的原注。[\s\S]*网页新增译注。[\s\S]*另一句话。/);
    const bilingual = await (await fetch(base + "file?kind=bilingual")).text();
    assert.match(bilingual, /An edited author source/);
    const htmlResponse = await fetch(base + "file?kind=bilingualHtml");
    assert.match(htmlResponse.headers.get("content-security-policy"), /script-src 'self' 'sha256-/);
    assert.doesNotMatch(htmlResponse.headers.get("content-security-policy"), /unsafe-inline/);
    const html = await htmlResponse.text();
    assert.match(html, /paragraph-notes/);
    assert.match(html, /网页新增译注/);
    assert.equal((await (await fetch(base + "review")).json()).model.annotations.revision, 2);
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); }
});
