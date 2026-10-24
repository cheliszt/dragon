import path from "node:path";
import { readFile } from "node:fs/promises";
import { APP_ROOT } from "./config.mjs";
import { buildChinese, buildBilingual, parseStructuredMarkdown } from "./markdown.mjs";
import { buildReviewDocument } from "./review-document.mjs";
import { mountReview, reviewMatches } from "../web/review.js";
import { blocksForTranslationRun, validatePlanCoverage } from "./translation-plan.mjs";
import { readJson, writeJson, writeText, sha256, normalizeText } from "./utils.mjs";
import { attachTermBaseline, loadTermBaseline } from './term-baseline.mjs';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function renderReviewHtml(model, { pdfUrl = null } = {}) {
  const title = model.title;
  const css = await readFile(path.join(APP_ROOT, "web/review.css"), "utf8");
  const serialized = JSON.stringify(model).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · 双语审阅</title>
<style>body{margin:0;background:#f5f7f6;color:#28332f;font-family:system-ui,sans-serif}main{max-width:980px;margin:auto;padding:24px}h1{font-size:22px;overflow-wrap:anywhere}button{font:inherit;cursor:pointer;padding:7px 12px;border:1px solid #c2cdc6;border-radius:4px;background:white}button:disabled{opacity:.4}a{color:#266753}*{box-sizing:border-box}${css}</style>
</head><body><main><h1>${escape(title)}</h1><div id="review"></div></main>
<script>${reviewMatches.toString()}\n(${mountReview.toString()})(document.getElementById('review'),${serialized},${JSON.stringify({ pdfUrl }).replace(/</g, "\\u003c")});</script></body></html>\n`;
}

export async function writeReadingOutputs(directory, blocks, translations, report, manifest) {
  const title = path.parse(path.basename(manifest.source.originalFile || manifest.projectId)).name;
  const model = attachTermBaseline(buildReviewDocument(blocks, translations, report, { title, sourceHash: manifest.source.approvedSha256, languages: manifest.languages }), await loadTermBaseline(directory));
  const chinese = buildChinese(blocks, translations);
  const bilingual = buildBilingual(blocks, translations);
  const pdfUrl = manifest.source.originalFile
    ? "../" + manifest.source.originalFile.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/") : null;
  const html = await renderReviewHtml(model, { pdfUrl });
  await writeText(path.join(directory, "06_zh/project_zh.md"), chinese);
  await writeText(path.join(directory, "05_bilingual/project_bilingual.md"), bilingual);
  await writeText(path.join(directory, "05_bilingual/project_bilingual.html"), html);
  await writeJson(path.join(directory, "04_qa/review-document.json"), model);
  await writeJson(path.join(directory, "04_qa/reading-output-map.json"), {
    version: model.version, sourceHash: model.sourceHash, sourceBlockIds: blocks.map((b) => b.block_id),
    translationBlockIds: translations.map((t) => t.block_id),
    readingBlockIds: [...new Set(model.units.filter((u) => !u.artifact).map((u) => u.blockId))],
    omittedLayoutBlockIds: blocks.map((b) => b.block_id).filter((id) => !model.units.some((u) => !u.artifact && u.blockId === id)),
    outputs: { chineseSha256: sha256(chinese), bilingualSha256: sha256(bilingual), htmlSha256: sha256(html) }
  });
  manifest.outputs = { ...manifest.outputs, chinese: "06_zh/project_zh.md", bilingual: "05_bilingual/project_bilingual.md",
    bilingualHtml: "05_bilingual/project_bilingual.html", qa: "04_qa/final.md" };
  manifest.reading = { version: model.version, paragraphs: model.units.filter((u) => !u.artifact).length,
    bodyIssues: model.issues.filter((q) => q.scope === "body").length,
    auxiliaryIssues: model.issues.filter((q) => q.scope === "auxiliary").length };
  return model;
}

export async function rebuildReadingOutputs(directory) {
  const manifest = await readJson(path.join(directory, "manifest.json"));
  if (["translating", "ocr_running", "source_inspecting"].includes(manifest.status)) throw new Error("请等待当前任务完成后再重建读稿。");
  const approved = normalizeText(await readFile(path.join(directory, manifest.source.approvedFile), "utf8"));
  if (sha256(approved) !== manifest.source.approvedSha256) throw new Error("批准原文已变化，拒绝套用旧译文。");
  const sourceBlocks = parseStructuredMarkdown(approved);
  let blocks;
  if (manifest.openai?.translationPlan && manifest.openai?.chunkDirectory) {
    let stored;
    try { stored = await readJson(path.join(directory, manifest.openai.chunkDirectory, "../translation-plan.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stored) {
      const { version, ...content } = stored;
      if (version !== manifest.openai.translationPlan.version || sha256(JSON.stringify(content)) !== version
        || stored.sourceDigest !== sha256(JSON.stringify(sourceBlocks)) || !validatePlanCoverage(stored)) throw new Error("历史翻译单元校验失败，拒绝套用译文。");
      blocks = stored.units;
    }
  }
  blocks ||= blocksForTranslationRun(sourceBlocks, manifest);
  const translations = [];
  for (let i = 1; i <= manifest.openai.chunkCount; i++) {
    const chunk = await readJson(path.join(directory, manifest.openai.chunkDirectory || "05_bilingual/chunks", `${String(i).padStart(4, "0")}-translated.json`));
    translations.push(...chunk.translations);
  }
  if (blocks.length !== translations.length || blocks.some((b, i) => b.block_id !== translations[i]?.block_id)) throw new Error("译文缓存与批准原文不匹配。");
  const report = await readJson(path.join(directory, "04_qa/final.json"));
  const model = await writeReadingOutputs(directory, blocks, translations, report, manifest);
  manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(directory, "manifest.json"), manifest);
  return model;
}
