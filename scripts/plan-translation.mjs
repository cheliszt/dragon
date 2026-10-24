import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseStructuredMarkdown } from "../src/markdown.mjs";
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";
import { normalizeText, readJson, sha256, writeJson } from "../src/utils.mjs";
import { APP_ROOT } from "../src/config.mjs";

if (!process.argv[2]) throw new Error("用法：node scripts/plan-translation.mjs <项目目录>");
const directory = path.resolve(process.argv[2]);
const manifest = await readJson(path.join(directory, "manifest.json"));
const approved = normalizeText(await readFile(path.join(directory, manifest.source.approvedFile), "utf8"));
if (sha256(approved) !== manifest.source.approvedSha256) throw new Error("批准原文哈希不匹配。");
const settings = await readJson(path.join(APP_ROOT, "config/settings.json"));
const plan = buildTranslationPlan(parseStructuredMarkdown(approved), manifest.openai?.translationPlan?.maxChars || settings.openai.unitMaxChars || settings.openai.chunkMaxChars, { pdfLayout: manifest.source.pdfLayout });
if (!validatePlanCoverage(plan)) throw new Error("源文覆盖检查未通过。");
const output = path.join(directory, "04_qa/translation-plan-preview.json");
await writeJson(output, plan);
console.log(JSON.stringify({ sourceBlocks: plan.sourceBlockIds.length, translationUnits: plan.units.length,
  crossPageUnits: plan.units.filter((u) => u.pages.length > 1).length,
  oversizeUnits: plan.units.filter((u) => u.source.length > plan.maxChars).length,
  sourceCoverageVerified: true, sentenceBoundariesVerified: validateSentenceBoundaries(plan),
  joinedWords: plan.normalizations.length, unfinished: plan.units.filter((u) => u.boundaryKind === "fragment").map((u) => u.block_id), output }, null, 2));
