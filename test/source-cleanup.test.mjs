import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { cleanSourceMarkdown, cleanSourceBlocks, applySourceRemovals, applySourceCleanup, cleanReviewSources, normalizePdfCallouts } from "../src/source-cleanup.mjs";
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { parseStructuredMarkdown, structureMarkdown } from "../src/markdown.mjs";
import { extractPdfText } from "../src/pdf-text.mjs";
import { prepareSource, resumePreparation } from "../src/pipeline.mjs";
import { writeJson, writeText } from "../src/utils.mjs";

const planFor = (text, size = 4500) => buildTranslationPlan(parseStructuredMarkdown(structureMarkdown(text)), size);
const example = 'Rave scenes.16 Today’s raves are hardly a situation that prefigures utopia. Morgan M. Page: “My kind will not survive the revolution.”17 Situation and story, two contrapuntal elements of prose writing.18 This text is mostly situations.';

test("flattened callouts become structured anchors at extraction and before translation", () => {
  const first = cleanSourceMarkdown(example);
  assert.equal(first.audit.callouts.length, 3);
  assert.match(first.markdown, /scenes\.\[\^16\]/);
  assert.equal(first.audit.normalizations.length, 3);
  assert.equal(cleanSourceMarkdown(first.markdown).audit.normalizations.length, 0);
  assert.equal(cleanSourceMarkdown(first.markdown).audit.removals.length, 0);
  // Legacy approved sources bypassed extraction cleanup but still get checked.
  const plan = planFor(example, 35);
  assert.equal(plan.sourceCleanup.callouts.length, 3);
  assert.ok(validatePlanCoverage(plan));
  assert.ok(validateSentenceBoundaries(plan));
  assert.match(plan.units.map((u) => u.source).join(""), /scenes\.\[\^16\]/);
  for (const s of plan.sources) assert.equal(applySourceCleanup(s.beforeCleanup, plan.sourceCleanup), s.originalSource);
  const changed = structuredClone(plan);
  changed.sources[0].source = changed.sources[0].source.replace("16", "");
  assert.equal(validatePlanCoverage(changed), false);
});

test("callout evidence crosses paragraphs and pages; joins and deletion offsets remain valid", () => {
  const source = 'A complete sentence.16 Another ner-\n\n<!-- pdf_page: 2 -->\n\nvous account.17 Then a third account.18 It ends.';
  const plan = planFor(source, 25);
  assert.equal(plan.sourceCleanup.callouts.length, 3);
  assert.match(plan.units.map((u) => u.source).join(""), /Another nervous account\./);
  assert.ok(validatePlanCoverage(plan));
  assert.ok(validateSentenceBoundaries(plan));
});

test("meaningful numbers, references, formulae and protected Markdown survive", () => {
  const text = 'In 2021, 16 people paid 17 dollars for 18 books, or 3.14 each. See Fig.16 then Fig.17 and Fig.18. Use x² and H2O; an area of 16 cm². [16] (Smith, 2021: 18).\n\n1. An item.\n2. Another item.\n\n| Year | Count |\n| 2021 | 16 |\n\n`a.16 b.17 c.18` https://example.org/a.16 https://example.org/b.17 https://example.org/c.18\n\n```\na.16 b.17 c.18\n```';
  assert.equal(cleanSourceMarkdown(text).markdown.trim(), text);
  assert.equal(cleanSourceMarkdown(text).audit.removals.length, 0);
  const lone = cleanSourceMarkdown('An ambiguous label.16 Keep it pending evidence.');
  assert.match(lone.markdown, /label\.16/);
  assert.equal(lone.audit.uncertain.length, 1);
});

test("explicit note markers, exponents and endnote bodies all remain", () => {
  const text = 'A sentence.<sup>16</sup>Next sentence.¹⁷ And another.[^18]\n\nAn area of m<sup>2</sup>.\n\nNOTES\n\n16 Situationist practices.\n17 Morgan Page, February 14, 2020.\n18 Gornick, Situation and Story.';
  const first = cleanSourceMarkdown(text);
  assert.equal(first.audit.callouts.length, 3);
  assert.match(first.markdown, /sentence\.\[\^16\] Next/);
  assert.match(first.markdown, /m<sup>2<\/sup>/);
  assert.match(first.markdown, /16 Situationist practices/);
  const plan = planFor(text);
  assert.equal(plan.sourceCleanup.callouts.length, 3);
  assert.ok(validatePlanCoverage(plan));
});

test("text fallback requires repeated folios with real prose; image plate labels survive", () => {
  const prose = "A sufficiently long paragraph about literary history and the many contexts that make interpretation possible.";
  const text = [1, 2, 3].map((p) => `<!-- pdf_page: ${p} -->\n\n${p}\n\n${prose}`).join("\n\n");
  assert.equal(planFor(text).sourceCleanup.removals.filter((r) => r.reason === "page-number-sequence").length, 3);
  const plates = [1, 2, 3].map((p) => `<!-- pdf_page: ${p} -->\n\n${p}`).join("\n\n");
  assert.equal(planFor(plates).sourceCleanup.removals.length, 0);
});

test("review cleanup preserves translation identities and human targets", () => {
  const units = example.split(/(?<=16|17) /).map((source, i) => ({ id: `U${i}`, source, target: `人工修改${i}`, section: "正文" }));
  const model = { version: "same-edition", units };
  const cleaned = cleanReviewSources(model);
  assert.equal(cleaned.version, model.version);
  assert.equal(cleaned.sourceCleanup.callouts.length, 3);
  assert.equal(cleaned.units[0].source, model.units[0].source);
  assert.deepEqual(cleaned.units.map((u) => [u.id, u.target]), units.map((u) => [u.id, u.target]));
  assert.ok(model.units[0].source.includes("16"));
});

test("PDF margins use spatial evidence; raw source and extraction audit are retained", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clean-source-"));
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) {
      const page = pdf.addPage([500, 700]);
      page.drawText(`Chapter One ${i}`, { x: 30, y: 30, size: 9, font });
      page.drawText(`A complete argument.${i} Another sentence describes the historical context of literary interpretation in 2021.`, { x: 30, y: 600, size: 10, font, maxWidth: 430 });
      page.drawText("16 people bought 18 books.", { x: 30, y: 530, size: 10, font });
    }
    const file = path.join(dir, "source.pdf");
    await writeFile(file, await pdf.save());
    const result = await extractPdfText(file);
    assert.match(result.rawMarkdown, /Chapter One/);
    assert.doesNotMatch(result.markdown, /Chapter One/);
    assert.match(result.markdown, /argument\.\[\^1\]/);
    assert.match(result.markdown, /16 people bought 18 books/);
    assert.equal(result.cleanup.removals.filter((r) => r.reason === "repeated-pdf-margin").length, 3);
    const project = await prepareSource(file, { projectsDir: path.join(dir, "projects"), mode: "text" });
    assert.match(await readFile(path.join(project.projectDir, "02_source_candidates/raw_text/document.md"), "utf8"), /argument\.1/);
    assert.match(await readFile(path.join(project.projectDir, project.manifest.source.candidateFile), "utf8"), /argument\.\[\^1\]/);
    const audit = JSON.parse(await readFile(path.join(project.projectDir, project.manifest.source.cleanup.auditFile), "utf8"));
    assert.equal(audit.removals.length, 3);
    assert.equal(audit.normalizations.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("removal ledger rejects overlapping edits and cannot invent source", () => {
  assert.throws(() => applySourceRemovals("Text.16", [{ offset: 5, removed: "17" }]));
  assert.throws(() => applySourceRemovals("Text.16", [{ offset: 5, removed: "16" }, { offset: 6, removed: "6" }]));
  const input = [{ block_id: "B1", text: "Text.16 Next.17 Done.18", section: "正文" }];
  assert.equal(cleanSourceBlocks(cleanSourceBlocks(input).blocks).removals.length, 0);
});

test("OCR result preparation retains author callouts and the unmodified JSONL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocr-cleanup-"));
  try {
    await writeJson(path.join(dir, "manifest.json"), { projectId: "test", source: { fileUrl: "https://example.test/book.pdf" },
      preparation: { requestedMode: "ocr" }, paddle: { jobId: "already-submitted", model: "test" } });
    const jsonl = JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: example, images: {} }, outputImages: {} }] } });
    const client = { waitForJob: async () => ({ data: { resultUrl: { jsonUrl: "https://example.test/result.jsonl" } } }),
      download: async (_url, file) => writeText(file, jsonl) };
    const result = await resumePreparation(dir, { paddleClient: client });
    assert.equal(await readFile(path.join(dir, "02_source_candidates/raw_ocr/document.jsonl"), "utf8"), jsonl);
    assert.match(await readFile(path.join(dir, "02_source_candidates/raw_ocr/document.md"), "utf8"), /scenes\.16/);
    assert.match(await readFile(path.join(dir, result.manifest.source.candidateFile), "utf8"), /scenes\.\[\^16\]/);
    assert.equal(result.manifest.source.cleanup.removed, 0);
    assert.equal(result.manifest.source.cleanup.structuredNotes, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a callout detached at a page boundary stays with its preceding sentence", () => {
  const plan = planFor('<!-- pdf_page: 1 -->\n\nA complete scene.\n\n<!-- pdf_page: 2 -->\n\n16 Today the story continues.17 A second story ends.18 Afterward we rest.', 25);
  assert.equal(plan.sourceCleanup.normalizations.length, 3);
  assert.ok(plan.units.some((u) => u.source.includes('A complete scene.[^16]')));
  assert.ok(plan.units.every((u) => !/^\s*\[\^/.test(u.source)));
  assert.ok(validatePlanCoverage(plan));
  assert.ok(validateSentenceBoundaries(plan));
  const amounts = ['15 People arrived.', '16 People stayed.', '17 People left.'].join('\n\n');
  assert.equal(cleanSourceMarkdown(amounts).markdown.trim(), amounts);
});

test("PDF superscript evidence distinguishes a single note from exponents, counts and figure references", () => {
  const item = (str, x, y, height, width = 80) => ({ str, width, height, transform: [height, 0, 0, height, x, y] });
  const page = { page: 1, view: [0, 0, 500, 700], items: [
    item('A complete argument.', 40, 600, 10), item('16', 120, 603, 7, 8),
    item('x', 40, 580, 10), item('2', 120, 583, 7, 8),
    item('See Fig.', 40, 560, 10), item('17', 120, 563, 7, 8),
    item('Pay', 40, 540, 10), item('18', 120, 540, 10, 12)
  ] };
  const result = normalizePdfCallouts([page]);
  assert.equal(result.normalizations.length, 1);
  assert.equal(result.pages[0].items[1].str, '[^16]');
  assert.equal(page.items[1].str, '16');
  assert.deepEqual(result.pages[0].items.filter((_, i) => i !== 1), page.items.filter((_, i) => i !== 1));
});

test("normalization audit rejects invented note labels and overlap", () => {
  const normalization = { offset: 5, removed: '16', number: 16, reason: 'structured-note-callout', replacement: '[^16]' };
  assert.equal(applySourceCleanup('Text.16', { normalizations: [normalization] }), 'Text.[^16]');
  assert.throws(() => applySourceCleanup('Text.16', { normalizations: [{ ...normalization, replacement: '[^17]' }] }));
  assert.throws(() => applySourceCleanup('Text.16', { normalizations: [normalization, normalization] }));
});

test("Markdown note and bibliography sections cannot establish a body callout sequence", () => {
  const text = '# NOTES\n\nUncertain reference.16 Next reference.17 Another reference.18\n\n# REFERENCES\n\nA reference.19 Another.20 Last.21';
  assert.equal(cleanSourceMarkdown(text).audit.removals.length, 0);
  assert.equal(planFor(text).sourceCleanup.removals.length, 0);
});
