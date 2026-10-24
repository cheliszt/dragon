import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTranslationPlan, blocksForTranslationRun, validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { prepareTranslationInput } from "../src/normalized-source.mjs";
import { chunkBlocks, parseStructuredMarkdown, structureMarkdown } from "../src/markdown.mjs";
import { runTranslationJob } from "../src/translation-jobs.mjs";
import { writeReadingOutputs, rebuildReadingOutputs } from "../src/reading-outputs.mjs";
import { writeJson, writeText, sha256 } from "../src/utils.mjs";

const blocks = (text) => parseStructuredMarkdown(structureMarkdown(text));

test("cross-page prose becomes whole sentences across page markers and running heads", () => {
  const source = blocks('<!-- pdf_page: 30 -->\n\n2 Chapter 1\n\nThey enter the\n\n<!-- pdf_page: 31 -->\n\n3 Chapter 1\n\nroom together. She watches them.\n\n<!-- pdf_page: 32 -->\n\n4 Chapter 1\n\nThey leave.');
  const plan = buildTranslationPlan(source, 30);
  assert.equal(plan.units[0].source.trim(), 'They enter the room together.');
  assert.deepEqual(plan.units[0].pages, [30, 31]);
  assert.equal(plan.units[1].source.trim(), 'She watches them.');
  assert.ok(validatePlanCoverage(plan));
  assert.ok(plan.units.every((u) => !u.source.includes('Chapter 1')));
  const broken = structuredClone(plan);
  broken.units[0].sourceSpans[0].start++;
  assert.equal(validatePlanCoverage(broken), false);
});

test("abbreviations, quotations, decimals and note numbers stay with complete sentences", () => {
  const source = blocks('Dr. Smith paid 3.14 dollars. “It works!”7 Then he thanked Mr. Jones.');
  const plan = buildTranslationPlan(source, 18);
  assert.deepEqual(plan.units.map((u) => u.source.trim()), [
    'Dr. Smith paid 3.14 dollars.', '“It works!”7', 'Then he thanked Mr. Jones.'
  ]);
  assert.ok(validatePlanCoverage(plan));
});

test("cross-page hyphenation, CJK text, and long sentences are atomic despite small budgets", () => {
  const english = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\nThis is a night-\n\n<!-- pdf_page: 2 -->\n\nlife economy with many participants.'), 12);
  assert.equal(english.units.length, 1);
  assert.match(english.units[0].source, /nightlife/);
  assert.ok(validatePlanCoverage(english));
  assert.equal(chunkBlocks(english.units, 12).length, 1);
  const chinese = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\n这是一个跨页的\n\n<!-- pdf_page: 2 -->\n\n完整句子。下一句。'), 8);
  assert.equal(chinese.units[0].source, '这是一个跨页的完整句子。');
  assert.ok(validatePlanCoverage(chinese));
});

test("a wrapped year inside prose cannot prevent ner- / vous from becoming a complete cross-page sentence", () => {
  const plan = buildTranslationPlan(blocks('<!-- pdf_page: 64 -->\n\nSo much for the hot girl summer meme of\n2021. I feel chilled. Or maybe when I’m ner-\n\n<!-- pdf_page: 65 -->\n\nvous my body just amps up all the bad signals churning around, to find reasons to hide. This improved.'), 35);
  const sentence = plan.units.find((u) => u.source.includes('nervous'));
  assert.equal(sentence.source.trim(), 'Or maybe when I’m nervous my body just amps up all the bad signals churning around, to find reasons to hide.');
  assert.deepEqual(sentence.pages, [64, 65]);
  assert.ok(sentence.source.length > plan.maxChars);
  assert.ok(validatePlanCoverage(plan));
  assert.ok(validateSentenceBoundaries(plan));
  assert.ok(plan.units.every((u) => !/ner-$|^vous/.test(u.source)));
  assert.equal(plan.normalizations[0].after, 'nervous');
  assert.equal(plan.boundaries.find((b) => b.previousPage === 64 && b.nextPage === 65).reason, 'split-word');
  const corrupted = structuredClone(plan); corrupted.sources.find((s) => s.source.includes('ner')).source += '!';
  assert.equal(validatePlanCoverage(corrupted), false);
  const invented = structuredClone(plan); invented.units[0].source += ' invented text';
  assert.equal(validatePlanCoverage(invented), false);
});

test("empty PDF pages do not break prose; lexical hyphens and genuine structural barriers survive", () => {
  const dialect = buildTranslationPlan(blocks('Earlier OCR wrote localdialect speakers.\n\nThey spoke with local-\n\n<!-- pdf_page: 2 -->\n\ndialect speakers.'), 20);
  assert.ok(dialect.units.some((u) => u.source.includes('local-dialect speakers.')));
  const plan = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\nThis remains self-\n\n<!-- pdf_page: 2 -->\n\n<!-- pdf_page: 3 -->\n\naware even across a blank page.\n\n# A heading\n\n- One item\n- Another item'), 5);
  assert.equal(plan.units[0].source, 'This remains self-aware even across a blank page.');
  assert.deepEqual(plan.units[0].pages, [1, 3]);
  assert.ok(validateSentenceBoundaries(plan));
  const fragment = buildTranslationPlan(blocks('This manuscript is missing its\n\n# Next chapter\n\nComplete sentence.'), 10);
  assert.equal(validateSentenceBoundaries(fragment), false);
  assert.ok(fragment.units.some((u) => u.boundaryKind === 'fragment'));
});

test("obvious split words in numbered items are rejoined; a lowercase continuation is not a title", () => {
  const list = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\n1. This note describes feeling ner-\n\n<!-- pdf_page: 2 -->\n\nvous about the event.'), 20);
  assert.equal(list.units.length, 1);
  assert.equal(list.units[0].source, '1. This note describes feeling nervous about the event.');
  assert.ok(validatePlanCoverage(list));
  assert.ok(validateSentenceBoundaries(list));
  const short = buildTranslationPlan(blocks('This leads to\n\nthe\n\nnext sentence.'), 4);
  assert.equal(short.units.length, 1);
  assert.equal(short.units[0].source, 'This leads to the next sentence.');
});

test("approval-derived continuous source and boundary audit are saved without editing the approved transcription", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'continuous-source-'));
  const approved = structureMarkdown('<!-- pdf_page: 64 -->\n\nI am ner-\n\n<!-- pdf_page: 65 -->\n\nvous about it.');
  const manifest = { source: { approvedFile: 'approved/document.md' } };
  try {
    await writeText(path.join(directory, manifest.source.approvedFile), approved);
    const plan = await prepareTranslationInput(directory, manifest, parseStructuredMarkdown(approved), 10);
    assert.equal(await readFile(path.join(directory, manifest.source.approvedFile), 'utf8'), approved);
    assert.match(await readFile(path.join(directory, manifest.source.normalizedFile), 'utf8'), /I am nervous about it\./);
    const audit = JSON.parse(await readFile(path.join(directory, path.dirname(manifest.source.normalizedFile), 'boundary-audit.json'), 'utf8'));
    assert.equal(audit.sentenceBoundariesVerified, true);
    assert.equal(audit.planVersion, plan.version);
    assert.equal(manifest.source.normalization.joinedWords, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a page ending in a decimal point or before a closing quote is not a sentence boundary", () => {
  const decimal = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\nThe value is 3.\n\n<!-- pdf_page: 2 -->\n\n14 dollars.'), 8);
  assert.equal(decimal.units.length, 1);
  assert.equal(decimal.units[0].source, 'The value is 3.14 dollars.');
  const quote = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\nShe said, “Yes.\n\n<!-- pdf_page: 2 -->\n\n” Then we left.'), 20);
  assert.match(quote.units[0].source, /She said, “Yes\.\s*”/);
  assert.ok(validatePlanCoverage(quote));
});

test("headings, lists, tables, fences, TOC and bibliography are barriers", () => {
  const source = blocks('A fragment without its ending\n\n# New chapter\n\nComplete sentence.\n\n- Item one\n- Item two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\nCONTENTS\n\n1 Introduction 1\n\n2 Conclusion 10\n\nBIBLIOGRAPHY\n\nSmith, John. A Book. London, 2020.');
  const plan = buildTranslationPlan(source, 12);
  assert.ok(plan.units.some((u) => u.source === '# New chapter'));
  assert.ok(plan.units.some((u) => u.source.includes('- Item one\n- Item two')));
  assert.ok(plan.units.some((u) => u.source.includes('const x = 1;')));
  assert.equal(plan.units.filter((u) => u.section === '参考文献').length, 2);
  assert.ok(validatePlanCoverage(plan));
});

test("retry subdivision never separates a cross-page sentence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sentence-retry-'));
  const plan = buildTranslationPlan(blocks('<!-- pdf_page: 1 -->\n\nWe return to the\n\n<!-- pdf_page: 2 -->\n\nroom. Another sentence follows.'), 22);
  const calls = [];
  const client = { model: 'test', baseUrl: 'test', async translate(units) {
    calls.push(units.map((u) => u.source));
    if (units.length > 1) throw Object.assign(new Error('timeout'), { status: 524 });
    return { value: { translations: units.map((u) => ({ block_id: u.block_id, translation: '译文。' })) } };
  } };
  try {
    await runTranslationJob({ client, blocks: plan.units, context: { translationPlanVersion: plan.version }, cacheDir: directory });
    assert.equal(calls.length, 3);
    assert.equal(calls[1][0].trim(), 'We return to the room.');
    await runTranslationJob({ client, blocks: plan.units, context: { translationPlanVersion: plan.version }, cacheDir: directory });
    assert.equal(calls.length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("versioned reading outputs rebuild against translation units and retain every page link", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sentence-outputs-'));
  const approved = structureMarkdown('<!-- pdf_page: 1 -->\n\nWe enter the\n\n<!-- pdf_page: 2 -->\n\nroom.');
  const source = parseStructuredMarkdown(approved), plan = buildTranslationPlan(source, 50);
  const manifest = { source: { approvedFile: 'approved.md', approvedSha256: sha256(approved) }, projectId: 'test',
    openai: { translationPlan: { version: plan.version, maxChars: 50 }, chunkDirectory: 'run/chunks', chunkCount: 1 } };
  const translations = plan.units.map((u) => ({ block_id: u.block_id, translation: '我们进入房间。' }));
  const report = { issues: [{ block_id: plan.units[0].block_id, severity: 'warning', description: '核对房间', translation_quote: '房间' }] };
  try {
    await writeText(path.join(directory, 'approved.md'), approved);
    await writeJson(path.join(directory, 'run/chunks/0001-translated.json'), { translations });
    await writeJson(path.join(directory, '04_qa/final.json'), report);
    await writeReadingOutputs(directory, plan.units, translations, report, manifest);
    await writeJson(path.join(directory, 'manifest.json'), manifest);
    const model = await rebuildReadingOutputs(directory);
    assert.deepEqual(model.units[0].pages, [1, 2]);
    assert.deepEqual(model.issues[0].blockIds, [plan.units[0].block_id]);
    assert.equal((await readFile(path.join(directory, '06_zh/project_zh.md'), 'utf8')).trim(), '我们进入房间。');
    assert.throws(() => blocksForTranslationRun(source, { openai: { translationPlan: { version: 'old', maxChars: 50 } } }), /版本不匹配/);
    assert.equal(blocksForTranslationRun(source, {}), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
