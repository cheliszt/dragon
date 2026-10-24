import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { translateProject } from '../src/pipeline.mjs';
import { OpenAIClient } from '../src/openai-client.mjs';
import { structureMarkdown } from '../src/markdown.mjs';
import { languageSettings } from '../src/languages.mjs';
import { loadTermBaseline, termFile, validateTermEntry } from '../src/term-baseline.mjs';
import { readJson, writeJson, writeText, sha256 } from '../src/utils.mjs';

test('resume applies new fixed terms to unfinished units while preserving old successful split translations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'term-resume-'));
  const dir = path.join(root, 'projects/book');
  const env = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL'].map(k => [k, process.env[k]]));
  const original = Object.fromEntries(['extractTerms', 'consolidateTerms', 'analyzeLanguages', 'translate'].map(k => [k, OpenAIClient.prototype[k]]));
  const entry = validateTermEntry({ term: 'radio operator', translation: '收音员', aliases: [], variants: [], definition: '负责操作收音机的技术人员。' });
  const calls = [];
  let interrupted = true;
  try {
    process.env.OPENAI_API_KEY = 'mock'; process.env.OPENAI_MODEL = 'mock'; process.env.OPENAI_BASE_URL = 'http://unused.invalid/v1';
    const source = structureMarkdown('A radio operator arrived.\n\nA radio operator left.');
    await writeText(path.join(dir, 'approved.md'), source);
    for (const name of ['workflow.md', 'style-guide.md', 'glossary.md']) await writeText(path.join(dir, '00_shared', name), 'test');
    await writeJson(path.join(root, 'config/settings.json'), { openai: { model: 'mock', baseUrl: process.env.OPENAI_BASE_URL,
      chunkMaxChars: 4500, unitMaxChars: 1800, semanticQa: false, requestAttempts: 1 } });
    await writeJson(path.join(dir, 'manifest.json'), { projectId: 'book', status: 'source_approved', languages: languageSettings(),
      source: { approvedFile: 'approved.md', approvedSha256: sha256(source) } });
    OpenAIClient.prototype.extractTerms = async (blocks) => ({ value: { entries: [{ ...entry,
      evidence: [{ blockId: blocks[0].block_id, quote: blocks[0].source }] }] } });
    OpenAIClient.prototype.consolidateTerms = async () => ({ value: { entries: [entry] } });
    OpenAIClient.prototype.analyzeLanguages = async (blocks) => ({ value: { units: blocks.map(b => ({ block_id: b.block_id,
      segments: [{ text: b.source, language: 'en', reason: 'English source' }] })) } });
    OpenAIClient.prototype.translate = async (blocks, context) => {
      calls.push({ ids: blocks.map(b => b.block_id), standard: context.termBaseline.entries[0].translation });
      if (blocks.length > 1) throw Object.assign(new Error('split'), { status: 524 });
      if (interrupted && blocks[0].source.includes('left')) throw Object.assign(new Error('interrupted'), { status: 401 });
      return { value: { translations: blocks.map(b => ({ block_id: b.block_id,
        translation: context.termBaseline.entries[0].translation + (b.source.includes('arrived') ? '来了。' : '离开了。'),
        source_questions: [], translator_notes: [], term_exceptions: [] })) } };
    };
    await assert.rejects(translateProject(dir, { root }), /interrupted/);
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    assert.equal(manifest.draft.translatedUnits, 1);
    assert.match(await readFile(path.join(dir, manifest.outputs.chinese), 'utf8'), /收音员来了/);
    const baseline = await loadTermBaseline(dir);
    await writeJson(termFile(dir), { ...baseline, revision: baseline.revision + 1,
      entries: [{ ...baseline.entries[0], translation: '无线电操作员', variants: ['收音员'], origin: 'user' }] });
    // A further pause after loading the new context must not forget the old cache identity.
    await assert.rejects(translateProject(dir, { root, checkpoint: () => { throw Object.assign(new Error('paused'), { code: 'PAUSED' }); } }), /paused/);
    interrupted = false;
    const before = calls.length;
    const result = await translateProject(dir, { root });
    assert.deepEqual(calls.slice(before), [{ ids: [calls[2].ids[0]], standard: '无线电操作员' }]);
    const text = await readFile(path.join(dir, result.manifest.outputs.chinese), 'utf8');
    assert.match(text, /收音员来了/);
    assert.match(text, /无线电操作员离开了/);
    assert.equal(result.manifest.draft.translatedUnits, 2);
    assert.equal(result.manifest.draft.qaComplete, true);
    assert.ok(result.report.issues.some(q => q.category === 'terminology_inconsistency'), 'old accepted wording remains reviewable');
  } finally {
    for (const [key, value] of Object.entries(original)) OpenAIClient.prototype[key] = value;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
