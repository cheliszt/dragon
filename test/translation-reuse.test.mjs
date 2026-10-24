import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { translationReuse } from "../src/translation-reuse.mjs";
import { buildTranslationPlan } from "../src/translation-plan.mjs";
import { structureMarkdown, parseStructuredMarkdown, chunkBlocks } from "../src/markdown.mjs";
import { writeJson, sha256 } from "../src/utils.mjs";
import { deterministicQa } from "../src/qa.mjs";

test("boundary migration reuses only exact sourced translations and rechecks changed neighborhoods", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plan-reuse-'));
  const source = parseStructuredMarkdown(structureMarkdown('First full sentence.\n\nSecond full sentence.\n\nThird full sentence.\n\nFourth full sentence.\n\nFifth full sentence.'));
  const old = buildTranslationPlan(source, 22);
  const plan = structuredClone(old);
  plan.units[2].source = 'A revised third sentence.';
  plan.units[2].block_id = 'U000099';
  plan.units[4].block_id = 'U000100';
  plan.version = 'new-version';
  const context = { workflow: 'workflow', styleGuide: 'style', glossary: 'glossary', targetLanguage: '简体中文', translationPlanVersion: plan.version };
  const config = { model: 'test', baseUrl: 'https://example.test/v1' };
  const manifest = { source: { approvedSha256: 'approved' }, openai: { ...config, targetLanguage: context.targetLanguage,
    chunkCount: 1, chunkDirectory: 'old/chunks', translationPlan: { version: old.version } },
    sharedInputs: { workflowSha256: sha256(context.workflow), styleGuideSha256: sha256(context.styleGuide), glossarySha256: sha256(context.glossary) } };
  const translations = old.units.map((u) => ({ block_id: u.block_id, translation: `原译文 ${u.block_id}。`, translator_notes: ['原注释'] }));
  try {
    await writeJson(path.join(dir, 'old/translation-plan.json'), old);
    await writeJson(path.join(dir, 'old/chunks/0001-translated.json'), { translations });
    await writeJson(path.join(dir, '04_qa/final.json'), { sourceSha256: 'approved', issues: [
      ...deterministicQa(old.units, translations),
      { block_id: 'U000005', category: 'meaning', severity: 'warning', description: 'Check U000005 wording.' },
      { block_id: 'U000003', category: 'meaning', severity: 'warning', description: 'Outdated issue.' }
    ] });
    const chunks = chunkBlocks(plan.units, 20);
    const result = await translationReuse(dir, manifest, plan, chunks, context, config);
    assert.equal(Object.keys(result.translations).length, 4);
    assert.equal(result.translations.U000100.translation, '原译文 U000005。');
    assert.equal(result.translations.U000099, undefined);
    assert.deepEqual(result.reviewChunks, [1, 2, 3]);
    assert.deepEqual(result.issues.map((q) => q.block_id), ['U000100']);
    assert.equal(result.issues[0].description, 'Check U000100 wording.');
    assert.equal((await translationReuse(dir, { ...manifest, openai: { ...manifest.openai, translationPlan: { version: plan.version } } }, plan, chunks, context, config)).fromPlanVersion, old.version);
    assert.equal(Object.keys((await translationReuse(dir, manifest, plan, chunks, { ...context, targetLanguage: '法语' }, config)).translations).length, 0);
    assert.equal(Object.keys((await translationReuse(dir, manifest, plan, chunks, { ...context, styleGuide: 'different' }, config)).translations).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
