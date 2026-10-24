// Read-only preflight: never submits a translation or language-detection request.
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { readJson, sha256, sha256File, normalizeText } from "../src/utils.mjs";
import { chunkBlocks, parseStructuredMarkdown } from "../src/markdown.mjs";
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { projectLanguages, validateLanguageAnalysis, analyzeLanguages } from "../src/languages.mjs";
import { taskState } from "../src/task-manager.mjs";
import { translationOwner } from "../src/translation-lock.mjs";

const root = process.cwd(), dir = path.resolve(process.argv[2]);
const m = await readJson(path.join(dir, "manifest.json")), config = await loadConfig(root);
const task = await taskState(root), owner = await translationOwner(root);
assert.equal(task.projectId, m.projectId);
assert.equal(task.state, "paused");
assert.equal(task.workerAlive, false);
assert.equal(task.active, false);
assert.equal(owner, null);
assert.equal(m.status, "translation_paused");
assert.ok(process.env.OPENAI_API_KEY?.trim(), "API key missing");
const approved = normalizeText(await readFile(path.join(dir, m.source.approvedFile), "utf8"));
assert.equal(sha256(approved), m.source.approvedSha256);
assert.equal(await sha256File(path.join(dir, m.source.originalFile)), m.source.sha256);
const plan = buildTranslationPlan(parseStructuredMarkdown(approved), m.openai.translationPlan.maxChars, { pdfLayout: m.source.pdfLayout });
assert.equal(plan.version, m.openai.translationPlan.version);
assert.ok(validatePlanCoverage(plan) && validateSentenceBoundaries(plan));
const settings = projectLanguages(m, config), chunks = chunkBlocks(plan.units, config.openai.chunkMaxChars);
assert.deepEqual(settings, m.languages);
assert.equal(chunks.length, m.openai.chunkCount);
const folder = path.join(dir, m.openai.chunkDirectory), cacheDir = path.join(folder, "requests");
assert.equal(m.openai.chunkDirectory, `05_bilingual/runs/${plan.version}/${sha256(JSON.stringify(settings))}/chunks`);
const model = config.openai.model, baseUrl = config.openai.baseUrl.replace(/\/$/, "");
assert.equal(model, m.openai.model);
assert.equal(baseUrl, m.openai.baseUrl);
const files = await readdir(cacheDir), detected = new Set();
let languageFiles = 0, jsonFiles = 0;
for (const file of files) {
  assert.ok(file.endsWith(".json"), `Unexpected temporary file: ${file}`);
  const cached = await readJson(path.join(cacheDir, file)); jsonFiles++;
  if (!file.startsWith("languages-")) continue;
  const blocks = cached.value.units.map((u) => plan.units.find((b) => b.block_id === u.block_id));
  assert.ok(blocks.every(Boolean));
  validateLanguageAnalysis(blocks, cached.value);
  const key = sha256(JSON.stringify({ blocks, settings, model, baseUrl }));
  assert.equal(cached.key, key, `Cache identity mismatch: ${file}`);
  assert.equal(file, `languages-${key}.json`);
  for (const b of blocks) detected.add(b.block_id);
  languageFiles++;
}
const hitChunks = [], missingChunks = [];
const client = { model, baseUrl, analyzeLanguages: async () => { throw Object.assign(new Error("Offline cache miss"), { code: "OFFLINE_MISS" }); } };
for (const [i, blocks] of chunks.entries()) {
  try { await analyzeLanguages({ client, blocks, context: settings, cacheDir }); hitChunks.push(i + 1); }
  catch (e) { if (e.code !== "OFFLINE_MISS") throw e; missingChunks.push(i + 1); }
}
const chunkFiles = await readdir(folder);
const translatedChunks = chunkFiles.filter((f) => /^\d{4}-translated\.json$/.test(f)).length;
assert.equal(translatedChunks, m.openai.translatedChunks);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), projectId: m.projectId,
  taskState: task.state, workerAlive: task.workerAlive, owner, languages: settings,
  sourceUnits: plan.units.length, totalChunks: chunks.length, detectedUnits: detected.size,
  languageCacheFiles: languageFiles, validatedJsonFiles: jsonFiles, reusableWholeChunks: hitChunks.length,
  firstMissingChunk: missingChunks[0] ?? null, translatedChunks, reviewedChunks: m.openai.reviewedChunks,
  sourceHashesVerified: true, currentPlanVerified: true, cacheIdentitiesVerified: true,
  realApiRequests: 0 }, null, 2));
