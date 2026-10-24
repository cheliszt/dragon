import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredMarkdown, structureMarkdown } from "../src/markdown.mjs";
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";

const planFor = (text, maxChars = 80) => buildTranslationPlan(parseStructuredMarkdown(structureMarkdown(text)), maxChars);
const verified = (plan) => { assert.ok(validatePlanCoverage(plan)); assert.ok(validateSentenceBoundaries(plan)); };

test("thesis cover, abstract and letter signature are distinguished from unfinished prose", () => {
  const plan = planFor('<!-- pdf_page: 1 -->\n\nListening to the State: Radio and Sound\n\nby\n\nYu Wang\n\nA thesis submitted in conformity with the requirements\nfor the degree of Doctor of Philosophy\nUniversity of Toronto\n\n© Copyright 2019\n\n<!-- pdf_page: 2 -->\n\nAbstract\n\nThe argument concerns the\n\nchanging role of radio.\n\n<!-- pdf_page: 10 -->\n\n落款：松云于太原');
  verified(plan);
  assert.equal(plan.units.find((u) => u.source.startsWith('Listening')).boundaryKind, 'structure');
  assert.ok(plan.units.some((u) => u.source === 'The argument concerns the changing role of radio.' && u.section === '正文' && u.boundaryKind === 'sentence'));
  assert.equal(plan.units.at(-1).source, '落款：松云于太原');
  const broken = planFor('<!-- pdf_page: 1 -->\n\nThis thesis discusses the\n\n# A new chapter\n\nComplete sentence.');
  assert.equal(validateSentenceBoundaries(broken), false);
});

test("consecutive Roman folios are retained without breaking cross-page acknowledgments", () => {
  const plan = planFor('<!-- pdf_page: 4 -->\n\niv\n\nAcknowledgments\n\nI thank my colleagues for the\n\n<!-- pdf_page: 5 -->\n\nv\n\nhelp they gave me.\n\n<!-- pdf_page: 6 -->\n\nvi\n\nTable of Contents\n\nIntroduction 1');
  verified(plan);
  assert.ok(plan.units.some((u) => u.source === 'I thank my colleagues for the help they gave me.'));
  assert.deepEqual(plan.units.filter((u) => u.section === '排版与定位记录').map((u) => u.source), ['iv', 'v', 'vi']);
  assert.equal(plan.layoutClassifications.filter((c) => c.reason === 'roman-page-label').length, 3);
  const isolated = planFor('<!-- pdf_page: 4 -->\n\nI\n\nA complete sentence.');
  assert.ok(!isolated.layoutClassifications.some((c) => c.reason === 'roman-page-label'));
});

test("page-foot citations stay separate while pending prose joins the following page", () => {
  const plan = planFor('<!-- pdf_page: 173 -->\n\nEarlier evidence.[^10] More evidence.[^11] Further evidence.[^12]\n\nA newspaper reported that one\n\n10\n\nBenjamin Lau, A Report, June 7, 2019.\n\n11 Tom Gunning, An Article, 2003.\n\n12 Anonymous, A Report, 2019.\n\n<!-- pdf_page: 174 -->\n\ncertain person had written software.\n\nBibliography\n\nA reference.');
  verified(plan);
  const body = plan.units.find((u) => u.source.startsWith('A newspaper'));
  assert.equal(body.source, 'A newspaper reported that one certain person had written software.');
  assert.deepEqual(body.pages, [173, 174]);
  assert.equal(body.sourceSpans.length, 2);
  const notes = plan.units.filter((u) => u.section === '注释与附录');
  assert.deepEqual(notes.map((u) => u.source), ['10 Benjamin Lau, A Report, June 7, 2019.', '11 Tom Gunning, An Article, 2003.', '12 Anonymous, A Report, 2019.']);
  assert.ok(plan.units.indexOf(body) < plan.units.indexOf(notes[0]));
});

test("split-word normalization targets the body span across intervening citations", () => {
  const plan = planFor('<!-- pdf_page: 3 -->\n\nEvidence.[^1] More evidence.[^2]\n\nPeople were ner-\n\n1 Smith, First Source, 2010.\n\n2 Jones, Second Source, 2011.\n\n<!-- pdf_page: 4 -->\n\nvous about it.', 12);
  verified(plan);
  assert.ok(plan.units.some((u) => u.source === 'People were nervous about it.'));
  assert.equal(plan.normalizations[0].after, 'nervous');
  assert.ok(plan.units.some((u) => u.source === '2 Jones, Second Source, 2011.'));
});

test("unreferenced numbered text is not moved or exempted from missing-text validation", () => {
  const plan = planFor('<!-- pdf_page: 3 -->\n\nAn unfinished account of\n\n1 Smith, A Source, 2010.\n\n2 Jones, Another Source, 2011.\n\n# New chapter\n\nA sentence.');
  assert.ok(!plan.layoutClassifications.some((c) => c.reason === 'page-footnote'));
  const broken = planFor('<!-- pdf_page: 3 -->\n\nEvidence.[^1] More evidence.[^2]\n\nAn account missing its\n\n1 Smith, A Source, 2010.\n\n2 Jones, Another Source, 2011.\n\n<!-- pdf_page: 4 -->\n\n# Next chapter');
  assert.ok(validatePlanCoverage(broken));
  assert.equal(validateSentenceBoundaries(broken), false);
});
