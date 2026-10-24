import path from "node:path";
import { randomUUID } from "node:crypto";
import { reviewSnapshot } from "./review-edits.mjs";
import { qaDirectory, qaUnitHash, readReviewChecks } from "./review-qa.mjs";
import { loadAuthorTerminology, terminologyContext } from "./author-terminology.mjs";
import { loadConfig, loadPromptFiles, requireSecret } from "./config.mjs";
import { OpenAIClient } from "./openai-client.mjs";
import { chunkBlocks } from "./markdown.mjs";
import { annotationText } from "./annotations.mjs";
import { runTranslationJob } from "./translation-jobs.mjs";
import { deterministicQa } from "./qa.mjs";
import { applyNumericPolicy } from "./numeric-qa.mjs";
import { loadTermBaseline, termContext, terminologyIssues } from "./term-baseline.mjs";
import { readJson, writeJson, sha256 } from "./utils.mjs";
import { projectLanguages } from "./languages.mjs";

export async function reviewCurrentDraft(dir, { root, runId = randomUUID(), mode = "changed", unitIds, client,
  checkpoint = () => {}, sleepImpl, onProgress = () => {} } = {}) {
  const snapshot = await reviewSnapshot(dir);
  const folder = qaDirectory(dir, snapshot.model.version);
  const runFile = path.join(folder, "runs", `${runId}.json`);
  let run;
  try { run = await readJson(runFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const config = await loadConfig(root);
  if (!run) {
    const units = snapshot.model.units.filter((u) => !u.artifact && (unitIds ? unitIds.includes(u.id) : mode === "all" || u.qa.state === "stale"));
    const prompts = await loadPromptFiles(path.join(dir, "00_shared"));
    run = { id: runId, version: snapshot.model.version, groupingVersion: snapshot.edits.grouping?.version, editRevision: snapshot.edits.revision, mode,
      createdAt: new Date().toISOString(), units, context: { workflow: prompts["workflow.md"],
        styleGuide: prompts["style-guide.md"], glossary: prompts["glossary.md"], ...(snapshot.model.languages || projectLanguages(await readJson(path.join(dir, "manifest.json")), config)),
        authorTerminology: terminologyContext(await loadAuthorTerminology(dir)),
        termBaseline: termContext(await loadTermBaseline(dir)),
        humanRevision: snapshot.edits.revision, reviewPolicy: "human-primary-v1" } };
    await writeJson(runFile, run);
  }
  if (run.version !== snapshot.model.version) throw new Error("质检快照所属读稿已变化，旧结果保留，未套入新书稿。");
  client ||= new OpenAIClient({ ...config.openai, apiKey: requireSecret("OPENAI_API_KEY") });
  const blocks = run.units.map((u) => ({ block_id: u.id, source: u.source, section: u.section, page: u.page, noteCallouts: u.noteCallouts }));
  const batches = chunkBlocks(blocks, config.openai.chunkMaxChars);
  let done = 0;
  for (const batch of batches) {
    await checkpoint();
    await onProgress({ phase: "review-current", completed: done, total: blocks.length, editRevision: run.editRevision });
    const units = batch.map((b) => run.units.find((u) => u.id === b.block_id));
    const translations = units.map((u) => ({ block_id: u.id, translation: annotationText(u.target, u.authorNotes || []), language_reviews: u.languageReviews, term_exceptions: u.termExceptions || [] }));
    const result = await runTranslationJob({ client, blocks: batch, translations, context: run.context,
      cacheDir: path.join(folder, "requests"), review: true, checkpoint, sleepImpl,
      onEvent: (event) => onProgress({ ...event, completed: done, total: blocks.length, editRevision: run.editRevision }) });
    const checks = await readReviewChecks(dir, run.version);
    const raw = applyNumericPolicy([...deterministicQa(batch, translations), ...result.issues,
      ...terminologyIssues(batch, translations, run.context.termBaseline)], batch, translations);
    for (const unit of units) {
      const issues = raw.filter((q) => q.block_id.split(/[\s,;/]+/).includes(unit.id)).map((q) => ({ ...q,
        id: `qa-${sha256(JSON.stringify({ runId, unit: unit.id, q })).slice(0, 22)}`,
        blockIds: [unit.blockId], unitIds: [unit.id], scope: unit.scope, metadataOnly: false }));
      const related = new Set(issues.flatMap((q) => q.block_id.split(/[\s,;/]+/)));
      checks.units[unit.id] = { groupingVersion: run.groupingVersion, basisHash: qaUnitHash(unit), source: unit.source, target: unit.target,
        dependencies: Object.fromEntries(run.units.filter((u) => related.has(u.id)).map((u) => [u.id, qaUnitHash(u)])),
        editRevision: run.editRevision, checkedAt: new Date().toISOString(), runId, issues };
    }
    checks.revision++;
    await writeJson(path.join(folder, "history", `${runId}-${done}.json`), checks);
    await writeJson(path.join(folder, "current.json"), checks);
    done += batch.length;
  }
  run.completedAt = new Date().toISOString(); await writeJson(runFile, run);
  await onProgress({ phase: "completed", completed: done, total: blocks.length, editRevision: run.editRevision });
  return reviewSnapshot(dir);
}
