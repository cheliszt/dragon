import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseStructuredMarkdown } from "../src/markdown.mjs";
import { prepareTranslationInput } from "../src/normalized-source.mjs";
import { validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { withTranslationLock } from "../src/translation-lock.mjs";
import { normalizeText, readJson, sha256, writeJson } from "../src/utils.mjs";

if (!process.argv[2]) throw new Error("用法：node scripts/clean-source.mjs <项目目录>");
const directory = path.resolve(process.argv[2]);
await withTranslationLock(directory, async () => {
  const manifest = await readJson(path.join(directory, "manifest.json"));
  if (!manifest.source.approvedFile) throw new Error("项目尚无批准原文。");
  const approved = normalizeText(await readFile(path.join(directory, manifest.source.approvedFile), "utf8"));
  if (sha256(approved) !== manifest.source.approvedSha256) throw new Error("批准原文哈希不匹配，未更新。");
  const plan = await prepareTranslationInput(directory, manifest, parseStructuredMarkdown(approved), manifest.openai?.translationPlan?.maxChars || 4500);
  if (!validatePlanCoverage(plan) || !validateSentenceBoundaries(plan)) throw new Error("清理后的覆盖或完整句检查失败，未更新项目指针。");
  manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(directory, "manifest.json"), manifest);
  console.log(JSON.stringify({ removed: plan.sourceCleanup.removals.length, structuredNotes: plan.sourceCleanup.normalizations.length,
    layoutOmissions: plan.sourceCleanup.layoutOmissions.length, uncertain: plan.sourceCleanup.uncertain.length,
    coverageVerified: true, sentenceBoundariesVerified: true, sourceFile: path.join(directory, manifest.source.normalizedFile),
    auditFile: path.join(directory, manifest.source.normalization.cleanupFile) }, null, 2));
}, { details: { name: "离线清理连续原文" } });
