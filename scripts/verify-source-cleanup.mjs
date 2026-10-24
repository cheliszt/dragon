import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { extractPdfText } from "../src/pdf-text.mjs";
import { reviewSnapshot } from "../src/review-edits.mjs";
import { validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { cleanSourceMarkdown } from "../src/source-cleanup.mjs";
import { normalizeText, readJson, sha256, writeJson } from "../src/utils.mjs";

if (!process.argv[2]) throw new Error("用法：node scripts/verify-source-cleanup.mjs <项目目录>");
const dir = path.resolve(process.argv[2]);
const manifest = await readJson(path.join(dir, "manifest.json"));
const before = await reviewSnapshot(dir);
const approved = normalizeText(await readFile(path.join(dir, manifest.source.approvedFile), "utf8"));
assert.equal(sha256(approved), manifest.source.approvedSha256);
const plan = await readJson(path.join(dir, manifest.source.normalizedPlanFile));
assert.ok(validatePlanCoverage(plan));
assert.ok(validateSentenceBoundaries(plan));
const result = await extractPdfText(path.join(dir, manifest.source.originalFile));
assert.equal(cleanSourceMarkdown(result.markdown).markdown, result.markdown);
const after = await reviewSnapshot(dir);
assert.equal(after.edits.revision, before.edits.revision, "检查期间书稿版本发生变化，请对当前版本再运行检查。");
assert.deepEqual(after.model.units.map((u) => [u.id, u.target]), before.model.units.map((u) => [u.id, u.target]));
assert.equal(sha256(normalizeText(await readFile(path.join(dir, manifest.source.approvedFile), "utf8"))), manifest.source.approvedSha256);
const report = {
  checkedAt: new Date().toISOString(), paidApiCalls: 0,
  sourceHash: manifest.source.approvedSha256, editRevision: after.edits.revision,
  humanTextUnchanged: true, approvedSourceUnchanged: true,
  extraction: { pages: result.report.totalPages, removedLayout: result.cleanup.removals.length,
    structuredNotes: result.cleanup.normalizations.length, uncertain: result.cleanup.uncertain.length, idempotent: true },
  translationInput: { version: plan.version, removedLayout: plan.sourceCleanup.layoutOmissions.length + plan.sourceCleanup.removals.length,
    structuredNotes: plan.sourceCleanup.normalizations.length, uncertain: plan.sourceCleanup.uncertain.length,
    coverageVerified: true, sentenceBoundariesVerified: true },
  units: after.model.units.length, humanTargetDigest: sha256(JSON.stringify(after.model.units.map((u) => [u.id, u.target]))),
  authorDefinitions: after.model.terminology.entries.length
};
const folder = path.join(dir, "04_qa/source-cleanup-verification");
await writeJson(path.join(folder, "extraction-audit.json"), result.cleanup);
await writeJson(path.join(folder, "verification.json"), report);
console.log(JSON.stringify(report, null, 2));
