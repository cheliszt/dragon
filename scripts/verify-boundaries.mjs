import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseStructuredMarkdown, buildChinese, buildBilingual } from "../src/markdown.mjs";
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { buildReviewDocument } from "../src/review-document.mjs";
import { readJson, writeJson, normalizeText, sha256 } from "../src/utils.mjs";

if (!process.argv[2]) throw new Error("用法：node scripts/verify-boundaries.mjs <项目目录>");
const dir = path.resolve(process.argv[2]);
const manifest = await readJson(path.join(dir, "manifest.json"));
assert.ok(["completed", "qa_failed"].includes(manifest.status), "翻译与质检尚未完成，不能验证最终读稿。");
const approved = normalizeText(await readFile(path.join(dir, manifest.source.approvedFile), "utf8"));
assert.equal(sha256(approved), manifest.source.approvedSha256, "批准原文已变化。");
const plan = buildTranslationPlan(parseStructuredMarkdown(approved), manifest.openai.translationPlan.maxChars, { pdfLayout: manifest.source.pdfLayout });
assert.equal(plan.version, manifest.openai.translationPlan.version, "已发布译稿使用的不是当前分句规则。");
assert.ok(validatePlanCoverage(plan), "原文覆盖检查失败。");
assert.ok(validateSentenceBoundaries(plan), "仍有残句边界。");
const translations = [];
for (let i = 1; i <= manifest.openai.chunkCount; i++) {
  const chunk = await readJson(path.join(dir, manifest.openai.chunkDirectory, `${String(i).padStart(4, "0")}-translated.json`));
  translations.push(...chunk.translations);
}
assert.deepEqual(translations.map((t) => t.block_id), plan.units.map((u) => u.block_id), "译文与新单元不对应。");
const report = await readJson(path.join(dir, "04_qa/final.json"));
const model = await readJson(path.join(dir, "04_qa/review-document.json"));
const rebuilt = buildReviewDocument(plan.units, translations, report, { title: model.title, sourceHash: manifest.source.approvedSha256 });
assert.equal(model.version, rebuilt.version, "双语审阅尚未更新。");
assert.equal(await readFile(path.join(dir, "06_zh/project_zh.md"), "utf8"), buildChinese(plan.units, translations), "中文导出稿尚未更新。");
assert.equal(await readFile(path.join(dir, "05_bilingual/project_bilingual.md"), "utf8"), buildBilingual(plan.units, translations), "双语导出稿尚未更新。");
const result = { verifiedAt: new Date().toISOString(), approvedSha256: manifest.source.approvedSha256,
  planVersion: plan.version, readingVersion: model.version, translationUnits: plan.units.length,
  reusedUnits: manifest.openai.reusedUnits || 0, joinedBoundaries: plan.boundaries.filter((b) => b.action === "join").length,
  joinedWords: plan.normalizations.length, sourceCoverageVerified: true, sentenceBoundariesVerified: true,
  readingAndExportsVerified: true, qaSummary: report.summary,
  wordRepairs: plan.normalizations.map((n) => ({ before: n.before, after: n.after, sourceBlocks: [n.block_id, n.nextBlock] })) };
await writeJson(path.join(dir, "04_qa/boundary-repair-verification.json"), result);
console.log(JSON.stringify(result, null, 2));
