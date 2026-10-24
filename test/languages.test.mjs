import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { languageSettings, languageInstructions, validateLanguageAnalysis, shouldPreserve, analyzeLanguages } from "../src/languages.mjs";
import { OpenAIClient } from "../src/openai-client.mjs";
import { runTranslationJob } from "../src/translation-jobs.mjs";
import { deterministicQa } from "../src/qa.mjs";
import { buildTranslationPlan } from "../src/translation-plan.mjs";
import { buildChinese, buildBilingual, structureMarkdown, parseStructuredMarkdown } from "../src/markdown.mjs";
import { translateProject } from "../src/pipeline.mjs";
import { writeJson, writeText, readJson, sha256 } from "../src/utils.mjs";
import { reviewSnapshot, applyAnnotationEdit, applyReviewEdit } from "../src/review-edits.mjs";
import { createWebServer } from "../src/web-server.mjs";
import { reviewCurrentDraft } from "../src/review-qa-jobs.mjs";
import { rebuildReadingOutputs } from "../src/reading-outputs.mjs";
import { PDFDocument } from "pdf-lib";
import { loadConfig } from "../src/config.mjs";
import { taskState } from "../src/task-manager.mjs";
import { buildReviewDocument } from "../src/review-document.mjs";

const segment = (text, language) => ({ text, language, reason: language === "pinyin" ? "汉语文学语境中的拼音，有歧义需核对" : "测试语言证据" });
const block = (segments, id = "U000001") => ({ block_id: id, source: segments.map((s) => s.text).join(""), languageSegments: segments });
const context = (targetLanguage = "zh-Hans", sourceLanguages = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "pinyin"]) => ({
  ...languageSettings({ sourceLanguages, targetLanguage }), workflow: "默认简体中文。", styleGuide: "默认简体中文。", glossary: ""
});
const result = (id, translation, notes = []) => ({ block_id: id, translation, source_questions: [], translator_notes: notes });
const output = (value) => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] });

test("language selection validates codes, distinguishes Chinese scripts and includes pinyin with Chinese", () => {
  assert.deepEqual(languageSettings().sourceLanguages, ["en"]);
  for (const invalid of [null, [], { sourceLanguages: [] }, { sourceLanguages: ["fr"] }, { targetLanguage: "ja" }]) assert.throws(() => languageSettings(invalid));
  assert.equal(shouldPreserve(segment("ren", "pinyin"), context("en", ["zh-Hant"])), false);
  assert.match(languageInstructions(context()), /普通民众姓名可保留完整原文拼音/);
  assert.match(languageInstructions(context()), /广播从业者、机构人员和地名不适用此例外/);
  assert.equal(shouldPreserve(segment("ren", "pinyin"), context("zh-Hans", ["en"])), false);
  assert.equal(shouldPreserve(segment("原有中文。", "zh-Hans"), context()), true);
  assert.equal(shouldPreserve(segment("繁體。", "zh-Hant"), context()), false);
  assert.equal(shouldPreserve(segment("繁體。", "zh-Hant"), context("zh-Hans", ["en"])), true);
});

test("mixed selected languages translate while existing target, unselected and uncertain spans survive byte for byte", async () => {
  const b = block([segment("An argument. ", "en"), segment("原有中文：A  B\nC。", "zh-Hans"), segment("\nBonjour !\n", "other"), segment("日本語。", "ja"), segment("한국어。", "ko"), segment("繁體中文。", "zh-Hant")]);
  const client = new OpenAIClient({ apiKey: "unused" });
  client.structuredRequest = async (name, schema, instructions, input) => {
    assert.equal(name, "translation_chunk");
    assert.match(instructions, /目标语言：简体中文/);
    const sent = JSON.parse(input.split("\n\n").at(-1))[0];
    assert.equal(sent.readOnlyOriginal, b.source);
    assert.equal(sent.languageAnalysis.map((s) => s.text).join(""), b.source);
    assert.ok(!sent.source.includes("Bonjour"));
    return { value: { translations: [result(b.block_id, sent.source.replace("An argument. ", "一个论点。 ").replace("日本語。", "日语。").replace("한국어。", "韩语。").replace("繁體中文。", "繁体中文。"))] } };
  };
  const translated = (await client.translate([b], context())).value.translations;
  for (const preserved of ["原有中文：A  B\nC。", "\nBonjour !\n"]) assert.ok(translated[0].translation.includes(preserved));
  assert.ok(buildChinese([b], translated).includes("A  B\nC。"));
  assert.ok(buildBilingual([b], translated).includes("\nBonjour !\n"));
});

test("entire target-language and nonselected units bypass translation, and protection token corruption is rejected", async () => {
  const client = new OpenAIClient({ apiKey: "unused" });
  client.structuredRequest = async () => { throw new Error("translation must not be called"); };
  const bs = [block([segment("Already English,  unchanged.\nSecond line.", "en")]), block([segment("Bonjour !", "other")], "U000002")];
  const translated = (await client.translate(bs, context("en"))).value.translations;
  assert.deepEqual(translated.map((t) => t.translation), bs.map((b) => b.source));
  const mixed = block([segment("English. ", "en"), segment("不改动。", "zh-Hans")]);
  client.structuredRequest = async () => ({ value: { translations: [result(mixed.block_id, "改写了一切。")] } });
  await assert.rejects(client.translate([mixed], context()), /保留文字/);
});

test("protected names may follow translated word order while note markers stay ordered", async () => {
  const b = block([
    segment("The ", "en"), segment("Hu", "other"), segment(" letter reached ", "en"),
    segment("HPPRS", "other"), segment(".", "en"), segment("[^98]", "unknown"),
    segment(" Then it replied", "en"),
    segment("[^99]", "unknown")
  ]);
  const client = new OpenAIClient({ apiKey: "unused" });
  let tokens, translatedText;
  client.structuredRequest = async (name, schema, instructions, input) => {
    tokens = JSON.parse(input.split("\n\n").at(-1))[0].source.match(/⟦KEEP_[^⟧]*⟧/g);
    return { value: { translations: [result(b.block_id, translatedText(tokens))] } };
  };
  translatedText = (t) => `${t[1]} 收到了 ${t[0]} 的信。${t[2]}随后答复${t[3]}`;
  const translated = (await client.translate([b], context())).value.translations[0];
  assert.equal(translated.translation, "HPPRS 收到了 Hu 的信。[^98]随后答复[^99]");
  translatedText = (t) => `${t[1]} 收到了 ${t[0]} 的信。${t[3]}随后答复${t[2]}`;
  await assert.rejects(client.translate([b], context()), /乱序的注号/);
  translatedText = (t) => `${t[1]} 收到了 ${t[0]} 的信。${t[2]}随后答复${t[3]}⟦KEEP_fake_0⟧`;
  await assert.rejects(client.translate([b], context()), /无效的保留标记/);
});

test("Chinese pinyin output is flagged only when the original spelling remains", async () => {
  const b = block([segment("ren", "pinyin")]);
  const client = new OpenAIClient({ apiKey: "unused" });
  let translation = "仁（ren）", notes = [];
  client.structuredRequest = async () => ({ value: { translations: [result(b.block_id, translation, notes)] } });
  let translated = (await client.translate([b], context())).value.translations;
  assert.equal(translated[0].translation, "仁（ren）");
  assert.equal(deterministicQa([b], translated).find((q) => q.category === "pinyin_review").severity, "warning");
  const review = buildReviewDocument([{ ...b, translationUnit: true, scope: "auxiliary", section: "致谢" }], translated, { issues: deterministicQa([b], translated) });
  assert.equal(review.units[0].scope, "body", "pinyin is visible in the default manual QA view even in acknowledgments");
  translation = "benevolence";
  translated = (await client.translate([b], context("en"))).value.translations;
  assert.ok(translated[0].translator_notes[0].includes("ren"));
  notes = [];
  translated = (await client.translate([b], context("en"))).value.translations;
  assert.equal(translated[0].translation, "benevolence");
  assert.match(translated[0].translator_notes.join(""), /ren.*缺少.*译注/);
  notes = ["ren 暂解为仁。"];
  translation = "仁";
  translated = (await client.translate([b], context())).value.translations;
  assert.equal(translated[0].translation, "仁");
  assert.equal(translated[0].language_reviews.length, 0);
  assert.doesNotMatch(translated[0].translator_notes.join(""), /缺少原拼音括注/);
  translation = "仁(ren)";
  translated = (await client.translate([b], context())).value.translations;
  assert.equal(translated[0].translation, "仁(ren)");
  assert.match(translated[0].language_reviews[0].description, /仍含汉语拼音/);
});

test("a shortened pinyin name still raises review without retaining the whole source name", async () => {
  const b = block([segment("Qi Yue", "pinyin")]);
  const client = new OpenAIClient({ apiKey: "unused" });
  let translation = "齐越（Qi）";
  client.structuredRequest = async () => ({ value: { translations: [result(b.block_id, translation, [])] } });
  let translated = (await client.translate([b], context())).value.translations;
  assert.equal(translated[0].language_reviews[0]?.category, "pinyin_review");
  translation = "齐越";
  translated = (await client.translate([b], context())).value.translations;
  assert.equal(translated[0].language_reviews.length, 0);
});

test("AI revision respects project target and rejects edits to protected language fragments", async () => {
  const client = new OpenAIClient({ apiKey: "unused" });
  const input = { source: "中文。Keep this.", translation: "Chinese. Keep this.", languageSegments: [segment("中文。", "zh-Hans"), segment("Keep this.", "en")] };
  client.structuredRequest = async (name, schema, instructions) => {
    assert.match(instructions, /目标语言：英语/);
    return { value: { translation: "Revised. Keep this.", explanation: "修订中文对应的英文。" } };
  };
  assert.equal((await client.revise(input, context("en"))).value.translation, "Revised. Keep this.");
  client.structuredRequest = async () => ({ value: { translation: "Revised. Changed this.", explanation: "改写。" } });
  await assert.rejects(client.revise(input, context("en")), /原样保留/);
});

test("language analysis rejects invented/omitted characters, caches once and invalidates on language changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "language-cache-"));
  const bs = [{ block_id: "U000001", source: "Hello. 中文。" }];
  let detections = 0;
  const client = new OpenAIClient({ apiKey: "unused", model: "mock" });
  client.analyzeLanguages = async () => { detections++; return { value: { units: [{ block_id: bs[0].block_id, segments: [segment("Hello. ", "en"), segment("中文。", "zh-Hans")] }] } }; };
  client.structuredRequest = async (name, schema, instructions, input) => {
    const b = JSON.parse(input.split("\n\n").at(-1))[0];
    return { value: { translations: [result(b.block_id, b.source.replace("Hello. ", "你好。 ").replace("中文。", "Chinese."))] } };
  };
  try {
    const args = { client, blocks: bs, context: context(), cacheDir: dir, maxAttempts: 1 };
    const first = await runTranslationJob(args);
    assert.equal(first.translations[0].translation, "你好。 中文。");
    await runTranslationJob(args);
    assert.equal(detections, 1);
    await runTranslationJob({ ...args, context: context("en") });
    assert.equal(detections, 2);
    assert.throws(() => validateLanguageAnalysis(bs, { units: [{ block_id: bs[0].block_id, segments: [segment("Hello. 中文!", "en")] }] }), /逐字覆盖/);
    client.analyzeLanguages = async () => ({ value: { units: [] } });
    await assert.rejects(analyzeLanguages({ ...args, context: context("en", ["ja"]) }), /逐字覆盖/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("durable upload carries language selections through the worker into the extracted project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "language-upload-"));
  let web;
  try {
    await writeJson(path.join(root, "config/settings.json"), { openai: { model: "mock", baseUrl: "https://unused.invalid" }, paddle: {}, translation: { targetLanguage: "简体中文" }, recovery: { maxCycles: 1 } });
    const pdf = await PDFDocument.create(); pdf.addPage().drawText("Already English. A complete local test sentence.");
    web = createWebServer({ root, configLoader: () => loadConfig(root) });
    await new Promise((r) => web.listen(0, "127.0.0.1", r));
    const expected = languageSettings({ sourceLanguages: ["ja", "en", "zh-Hant"], targetLanguage: "en" });
    const response = await fetch(`http://127.0.0.1:${web.address().port}/api/upload`, { method: "POST", headers: { "X-Local-Request": "1", "X-Source-Mode": "text", "X-Translation-Languages": JSON.stringify(expected) }, body: await pdf.save() });
    assert.equal(response.status, 202);
    const { projectId } = await response.json();
    let task;
    for (let i = 0; i < 500; i++) { task = await taskState(root); if (task?.state === "completed" || task?.state === "needs_attention") break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(task.state, "completed", task.error);
    assert.deepEqual(task.languages, expected);
    const manifest = await readJson(path.join(root, "projects", projectId, "manifest.json"));
    assert.deepEqual(manifest.languages, expected);
    assert.equal(manifest.preparation.method, "text");
  } finally {
    if (web) await new Promise((r) => { web.close(r); web.closeAllConnections(); });
    const task = await taskState(root).catch(() => null);
    if (task?.workerAlive) { try { process.kill(task.pid); } catch {} }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("web settings, full pipeline, English downloads, pinyin notes, manual QA and recheck share the same language policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "language-workflow-")), dir = path.join(root, "projects/book");
  const env = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((k) => [k, process.env[k]]));
  const source = "中文文学讨论 ren。 Already English. Bonjour !";
  const segments = [segment("中文文学讨论 ", "zh-Hans"), segment("ren", "pinyin"), segment("。 ", "zh-Hans"), segment("Already English. ", "en"), segment("Bonjour !", "other")];
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    let value;
    if (body.text.format.name === "terminology_candidates") value = { entries: [] };
    else if (body.text.format.name === "language_analysis") {
      const blocks = JSON.parse(body.input);
      value = { units: blocks.map((b) => ({ block_id: b.block_id, segments })) };
    } else if (body.text.format.name === "translation_qa") value = { summary: "ok", issues: [] };
    else {
      const blocks = JSON.parse(body.input.split("\n\n").at(-1));
      value = { translations: blocks.map((b) => result(b.block_id, b.source.replace("中文文学讨论 ren。 ", "Chinese literature discusses benevolence. "), ["拼音待人工审核：ren 暂解为‘仁’，根据汉语文学语境译作 benevolence，仍需原页核实。 "])) };
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(output(value)));
  });
  let web;
  try {
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.OPENAI_API_KEY = "mock"; process.env.OPENAI_MODEL = "mock"; process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
    const config = { openai: { model: "mock", baseUrl: process.env.OPENAI_BASE_URL, stream: false, chunkMaxChars: 4500, semanticQa: true, requestAttempts: 1 }, translation: { targetLanguage: "简体中文" } };
    await writeJson(path.join(root, "config/settings.json"), config);
    const approved = structureMarkdown(source);
    await writeText(path.join(dir, "approved.md"), approved);
    for (const file of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(dir, "00_shared", file), "默认译成中文。");
    await writeJson(path.join(dir, "manifest.json"), { projectId: "book", createdAt: new Date().toISOString(), status: "source_approved", source: { approvedFile: "approved.md", approvedSha256: sha256(approved) } });
    const before = buildTranslationPlan(parseStructuredMarkdown(approved), 4500);
    let finished, failure;
    web = createWebServer({ root, configLoader: async () => config, workflow: { translateProject: async (project) => { try { finished = await translateProject(project, { root }); } catch (e) { failure = e; } } } });
    await new Promise((r) => web.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${web.address().port}/api/projects/book`;
    const post = (route, value) => fetch(base + route, { method: "POST", headers: { "X-Local-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(value) });
    assert.equal((await post("/translate", { sourceLanguages: [], targetLanguage: "en" })).status, 400);
    assert.equal((await post("/translate", { sourceLanguages: ["zh-Hans", "en"], targetLanguage: "en" })).status, 202);
    for (let i = 0; i < 200 && !finished && !failure; i++) await new Promise((r) => setTimeout(r, 10));
    if (failure) throw failure;
    assert.ok(finished, "pipeline completed");
    const manifest = await readJson(path.join(dir, "manifest.json"));
    assert.equal(manifest.languages.targetLanguage, "en");
    assert.equal(manifest.openai.translationPlan.version, before.version, "existing sentence/grouping logic remains unchanged");
    assert.deepEqual(requests.map((r) => r.text.format.name), ["terminology_candidates", "language_analysis", "translation_chunk", "translation_qa"]);
    assert.match(requests[2].instructions, /目标语言：英语/);
    assert.match(requests[3].instructions, /未选语言/);
    let snapshot = await reviewSnapshot(dir);
    const unit = snapshot.model.units[0];
    assert.equal(unit.target, "Chinese literature discusses benevolence. Already English. Bonjour !");
    assert.ok(snapshot.model.issues.some((q) => q.category === "pinyin_review" && q.scope === "body"));
    assert.ok(unit.translatorNotes[0].text.includes("ren"));
    const download = await fetch(base + "/file?kind=chinese&download=1");
    assert.match(download.headers.get("content-disposition"), /project_en\.md/);
    assert.match(await download.text(), /译注[\s\S]*ren/);
    assert.match(await (await fetch(base + "/file?kind=bilingualHtml")).text(), /benevolence/);
    const decision = await (await fetch(base + "/review")).json();
    const issue = snapshot.model.issues.find((q) => q.category === "pinyin_review");
    assert.equal((await post("/review", { version: snapshot.model.version, revision: decision.revision, issues: { [issue.id]: { status: "reviewed", note: "已对照原文核实" } }, scopes: {} })).status, 200);
    await applyAnnotationEdit(dir, { version: snapshot.model.version, revision: snapshot.model.annotations.revision, kind: "translator", noteId: unit.translatorNotes[0].id, unitId: unit.id, paragraphId: "p1", text: "人工确认：ren 此处是仁。" }, { root });
    await applyReviewEdit(dir, { version: snapshot.model.version, revision: 0, unitId: unit.id, before: unit.target, target: unit.target.replace("benevolence", "humaneness") }, { root });
    await reviewCurrentDraft(dir, { root, mode: "all" });
    snapshot = await reviewSnapshot(dir);
    assert.ok(snapshot.model.units[0].issueIds.some((id) => snapshot.model.issues.find((q) => q.id === id)?.category === "pinyin_review"));
    assert.equal(snapshot.model.units[0].translatorNotes[0].text, "人工确认：ren 此处是仁。");
    assert.match(requests.at(-1).instructions, /目标语言：英语/);
    await rebuildReadingOutputs(dir);
    snapshot = await reviewSnapshot(dir);
    assert.match(snapshot.model.units[0].target, /humaneness/);
    assert.equal(snapshot.model.units[0].translatorNotes[0].text, "人工确认：ren 此处是仁。");
    assert.equal(await readFile(path.join(dir, "approved.md"), "utf8"), approved);
    const retryManifest = await readJson(path.join(dir, 'manifest.json'));
    retryManifest.status = 'qa_failed'; await writeJson(path.join(dir, 'manifest.json'), retryManifest);
    const revision = snapshot.edits.revision, version = snapshot.model.version;
    const translatedBeforeRetry = requests.filter(r => r.text.format.name === 'translation_chunk').length;
    await translateProject(dir, { root });
    const retried = await reviewSnapshot(dir);
    assert.equal(retried.model.version, version); assert.equal(retried.edits.revision, revision);
    assert.match(retried.model.units[0].target, /humaneness/);
    assert.equal(requests.filter(r => r.text.format.name === 'translation_chunk').length, translatedBeforeRetry);
  } finally {
    if (web) await new Promise((r) => { web.close(r); web.closeAllConnections(); });
    await new Promise((r) => { upstream.close(r); upstream.closeAllConnections(); });
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
