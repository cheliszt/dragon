import path from "node:path";
import { readFile } from "node:fs/promises";
import { readJson, writeJson, writeText, sha256 } from "./utils.mjs";
import { validatePlanCoverage } from "./translation-plan.mjs";
import { validateTranslations } from "./translation-jobs.mjs";
import { deterministicQa } from "./qa.mjs";
import { readTranslationCheckpoint } from "./translation-checkpoint.mjs";

const identity = (unit) => JSON.stringify({ source: unit.source, blocks: [...new Set(unit.sourceSpans.map((s) => s.block_id))], section: unit.section });
const idsIn = (issue) => [...new Set(String(issue.block_id || "").match(/U\d+/g) || [])];

// Reuse only identical text with identical provenance and translation settings, never splice old translations to repair a sentence.
export async function translationReuse(dir, manifest, plan, chunks, context, config) {
  const adopted = await readTranslationCheckpoint(dir, manifest, plan, context.targetLanguage);
  // Published chunks are accepted work, not disposable prompt caches. A newer
  // QA/terminology policy must not erase them when continuing the same source.
  const saved = {};
  if (context.languagePolicy && manifest.openai?.translationPlan?.version === plan.version && manifest.openai.chunkDirectory
    && manifest.openai.model === config.model && manifest.openai.baseUrl === config.baseUrl
    && (manifest.languages?.targetLanguage || manifest.openai.targetLanguage) === context.targetLanguage
    && JSON.stringify(manifest.languages?.sourceLanguages || manifest.openai.sourceLanguages) === JSON.stringify(context.sourceLanguages)) {
    let old;
    try { old = await readJson(path.join(dir, manifest.openai.chunkDirectory, '../translation-plan.json')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) {
      const { version, ...content } = old;
      if (version !== plan.version || sha256(JSON.stringify(content)) !== version || !validatePlanCoverage(old)) throw new Error('已保存译文的原文版本校验失败，拒绝重新覆盖。');
      const ids = new Set(plan.units.map(u => u.block_id));
      for (let i = 1; i <= manifest.openai.chunkCount; i++) {
        let data;
        try { data = await readJson(path.join(dir, manifest.openai.chunkDirectory, `${String(i).padStart(4,'0')}-translated.json`)); }
        catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (!Array.isArray(data.translations) || data.translations.some(t => !ids.has(t.block_id) || saved[t.block_id] || typeof t.translation !== 'string' || !t.translation.trim())) throw new Error('已保存的译文单元无效，请核对；不会从头覆盖。');
        for (const item of data.translations) saved[item.block_id] = item;
      }
    }
  }
  if (adopted) return { ...adopted, adoptedUnitCount: Object.keys(adopted.translations).length,
    translations: { ...saved, ...adopted.translations }, reviewChunks: chunks.map((_, i) => i) };
  if (Object.keys(saved).length) return { translations: saved, issues: [], reviewChunks: chunks.map((_, i) => i), fromPlanVersion: plan.version };
  // Language detection and protected spans are part of the new request cache identity.
  // Legacy cross-plan reuse cannot prove these invariants; use the validated request cache.
  if (context.languagePolicy) return { translations: {}, issues: [], reviewChunks: chunks.map((_, i) => i), fromPlanVersion: null };
  const prompts = { workflowSha256: sha256(context.workflow), styleGuideSha256: sha256(context.styleGuide), glossarySha256: sha256(context.glossary) };
  if (context.authorTerminology) prompts.authorTerminologySha256 = sha256(JSON.stringify(context.authorTerminology));
  const signature = sha256(JSON.stringify({ plan: plan.version, prompts, model: config.model, baseUrl: config.baseUrl, targetLanguage: context.targetLanguage }));
  const file = path.join(dir, "05_bilingual/runs", plan.version, "reuse.json");
  let stored;
  try { stored = await readJson(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (stored?.signature === signature && stored.publicationBackup) return stored;
  const empty = { signature, translations: {}, issues: [], reviewChunks: chunks.map((_, i) => i), fromPlanVersion: null };
  const previous = manifest.openai;
  if (!previous?.translationPlan || previous.translationPlan.version === plan.version || previous.model !== config.model || previous.baseUrl !== config.baseUrl
    || previous.targetLanguage && previous.targetLanguage !== context.targetLanguage
    || Object.entries(prompts).some(([k, v]) => manifest.sharedInputs?.[k] !== v)) return empty;
  let old, report;
  try {
    old = await readJson(path.join(dir, previous.chunkDirectory, "../translation-plan.json"));
    report = await readJson(path.join(dir, "04_qa/final.json"));
  } catch (e) { if (e.code === "ENOENT") return empty; throw e; }
  const { version, ...contents } = old;
  if (version !== previous.translationPlan.version || sha256(JSON.stringify(contents)) !== version
    || old.sourceDigest !== plan.sourceDigest || !validatePlanCoverage(old) || report.sourceSha256 !== manifest.source.approvedSha256) return empty;
  const oldTranslations = [];
  for (let i = 1; i <= previous.chunkCount; i++) {
    let data;
    try { data = await readJson(path.join(dir, previous.chunkDirectory, `${String(i).padStart(4, "0")}-translated.json`)); }
    catch (e) { if (e.code === "ENOENT") return empty; throw e; }
    oldTranslations.push(...data.translations);
    if (!previous.targetLanguage) {
      const ids = new Set(data.translations.map((t) => t.block_id));
      const key = sha256(JSON.stringify({ blocks: old.units.filter((u) => ids.has(u.block_id)),
        context: { ...context, translationPlanVersion: version }, review: false, model: config.model, baseUrl: config.baseUrl.replace(/\/$/, "") }));
      try { if ((await readJson(path.join(dir, previous.chunkDirectory, "requests", `text-${key}.json`))).key !== key) return empty; }
      catch (e) { if (e.code === "ENOENT") return empty; throw e; }
    }
  }
  validateTranslations(old.units, oldTranslations);
  const byIdentity = new Map(old.units.map((unit, i) => [identity(unit), { unit, translation: oldTranslations[i] }]));
  const reused = {}, renamed = new Map(), changed = new Set();
  for (const [i, unit] of plan.units.entries()) {
    const match = byIdentity.get(identity(unit));
    if (match) {
      reused[unit.block_id] = { ...match.translation, block_id: unit.block_id };
      renamed.set(match.unit.block_id, unit.block_id);
    } else for (const n of [i - 1, i, i + 1]) if (plan.units[n]) changed.add(plan.units[n].block_id);
  }
  const reviewChunks = chunks.flatMap((chunk, i) => chunk.some((u) => changed.has(u.block_id)) ? [i] : []);
  const rechecked = new Set(reviewChunks.flatMap((i) => chunks[i].map((u) => u.block_id)));
  const mechanical = new Set(deterministicQa(old.units, oldTranslations).map((q) => JSON.stringify(q)));
  const issues = (report.issues || []).filter((issue) => {
    const ids = idsIn(issue);
    return !mechanical.has(JSON.stringify(issue)) && ids.length && ids.every((id) => renamed.has(id) && !rechecked.has(renamed.get(id)));
  }).map((issue) => Object.fromEntries(Object.entries(issue).map(([k, v]) => [k, typeof v === "string" ? v.replace(/U\d+/g, (id) => renamed.get(id) || id) : v])));
  const value = { signature, fromPlanVersion: version, translations: reused, issues, reviewChunks };
  const backup = path.join("05_bilingual/runs", version, "publication-before-boundary-repair");
  for (const relative of ["04_qa/final.json", "04_qa/final.md", "04_qa/review-document.json", "04_qa/review-decisions.json", ...Object.values(manifest.outputs || {})]) {
    try {
      const destination = path.join(dir, backup, relative);
      try { await readFile(destination); continue; } catch (e) { if (e.code !== "ENOENT") throw e; }
      await writeText(destination, await readFile(path.join(dir, relative)));
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  await writeJson(path.join(dir, backup, "manifest.json"), manifest);
  value.publicationBackup = backup;
  await writeJson(file, value);
  return value;
}
