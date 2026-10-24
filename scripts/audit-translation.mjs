import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseStructuredMarkdown } from "../src/markdown.mjs";
import { blocksForTranslationRun } from "../src/translation-plan.mjs";
import { readJson, writeJson, sha256, normalizeText } from "../src/utils.mjs";

const directory = path.resolve(process.argv[2]);
const manifest = await readJson(path.join(directory, "manifest.json"));
const approved = normalizeText(await readFile(path.join(directory, manifest.source.approvedFile), "utf8"));
const source = parseStructuredMarkdown(approved);
const units = blocksForTranslationRun(source, manifest);
const chinese = parseStructuredMarkdown(await readFile(path.join(directory, manifest.outputs.chinese), "utf8"));
const bilingual = parseStructuredMarkdown(await readFile(path.join(directory, manifest.outputs.bilingual), "utf8"));
const readingMap = manifest.reading ? await readJson(path.join(directory, "04_qa/reading-output-map.json")) : null;
const rows = [];
for (let i = 1; i <= manifest.openai.chunkCount; i++) {
  const chunk = await readJson(path.join(directory, manifest.openai.chunkDirectory || "05_bilingual/chunks", `${String(i).padStart(4, "0")}-translated.json`));
  rows.push(...chunk.translations);
}
const ids = (blocks) => blocks.map((b) => b.block_id).join(",");
const checks = {
  approvedHashMatches: sha256(approved) === manifest.source.approvedSha256,
  allChunksFinished: manifest.openai.completedChunks === manifest.openai.chunkCount,
  translationsMatchSource: ids(rows) === ids(units),
  chineseMatchesSource: readingMap ? sha256(await readFile(path.join(directory, manifest.outputs.chinese))) === readingMap.outputs.chineseSha256 : ids(chinese) === ids(source),
  bilingualMatchesSource: readingMap ? sha256(await readFile(path.join(directory, manifest.outputs.bilingual))) === readingMap.outputs.bilingualSha256 : ids(bilingual) === ids(source),
  readingMapCoversSource: !readingMap || (readingMap.sourceBlockIds.join(',') === ids(units) && units.every((b) => readingMap.readingBlockIds.includes(b.block_id) || readingMap.omittedLayoutBlockIds.includes(b.block_id))),
  noEmptyTranslations: rows.every((b) => typeof b.translation === "string" && b.translation.trim()),
  noMissingPlaceholders: rows.every((b) => !b.translation.includes("MISSING-TRANSLATION"))
};
const qa = await readJson(path.join(directory, "04_qa/final.json"));
const audit = { checkedAt: new Date().toISOString(), sourceRevision: manifest.source.revision,
  sourceSha256: sha256(approved), sourceBlocks: source.length, translatedBlocks: rows.length,
  checks, structurallyComplete: Object.values(checks).every(Boolean), qualityReview: qa.summary,
  qualification: "Block coverage is verified; semantic/source questions remain in final.json and are not waived." };
await writeJson(path.join(directory, "04_qa/completeness.json"), audit);
console.log(JSON.stringify(audit, null, 2));
if (!audit.structurallyComplete) process.exitCode = 1;
