import path from 'node:path';
import { loadConfig, loadPromptFiles, requireSecret, APP_ROOT } from '../src/config.mjs';
import { readJson, writeJson } from '../src/utils.mjs';
import { OpenAIClient } from '../src/openai-client.mjs';
import { prepareTermBaseline } from '../src/term-baseline.mjs';
import { withTranslationLock } from '../src/translation-lock.mjs';
import { projectLanguages } from '../src/languages.mjs';

// Analyze an existing edition without re-running translation or republishing it.
const projectId = process.argv[2];
if (!projectId || path.basename(projectId) !== projectId) throw new Error('Provide a project ID.');
const dir = path.join(APP_ROOT, 'projects', projectId);
const config = await loadConfig();
const manifest = await readJson(path.join(dir, 'manifest.json'));
const plan = await readJson(path.join(dir, manifest.openai.chunkDirectory, '..', 'translation-plan.json'));
if (plan.version !== manifest.openai.translationPlan.version) throw new Error('Source plan mismatch.');
const prompts = await loadPromptFiles(path.join(dir, '00_shared'));
const client = new OpenAIClient({ ...config.openai, apiKey: requireSecret('OPENAI_API_KEY') });
const baseline = await prepareTermBaseline(dir, plan.units, { client,
  maxAttempts: 5,
  sourceHash: manifest.source.approvedSha256, targetLanguage: projectLanguages(manifest, config).targetLanguage,
  glossary: prompts['glossary.md'],
  onProgress: async (progress) => { console.log(JSON.stringify(progress)); await writeJson(path.join(dir, '00_shared/term-analysis-progress.json'), progress); },
  commit: (operation) => withTranslationLock(dir, operation, { details: { name: '保存全文术语基线' } })
});
await writeJson(path.join(dir, '00_shared/term-analysis-progress.json'), { phase: 'ready', completed: baseline.coverage.batches,
  total: baseline.coverage.batches, sourceBlocks: baseline.coverage.blocks, entries: baseline.entries.length, revision: baseline.revision });
console.log(JSON.stringify({ status: baseline.status, coverage: baseline.coverage.blocks, entries: baseline.entries.length }));
