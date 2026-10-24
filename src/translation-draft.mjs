import path from "node:path";
import { writeText, writeJson } from "./utils.mjs";

// A draft is independent of final QA and never replaces a reviewed publication.
export function draftMarkdown(blocks, translations, { bilingual = false, label = "翻译工作稿" } = {}) {
  const byId = new Map(translations.map((t) => [t.block_id, t]));
  const available = blocks.filter((b) => byId.has(b.block_id));
  const lines = [`# ${label}`, "", `已保存 ${available.length}/${blocks.length} 个翻译单元。此稿尚未完成全篇质检；未译部分明确标出。页码为 PDF 文件页序。`, ""];
  let missing = [];
  const flush = () => {
    if (!missing.length) return;
    lines.push(`> 尚未生成译文：${missing[0].block_id}—${missing.at(-1).block_id}（PDF 第 ${missing[0].page ?? "?"}—${missing.at(-1).page ?? "?"} 页，共 ${missing.length} 个单元）。`, "");
    missing = [];
  };
  for (const b of blocks) {
    const t = byId.get(b.block_id);
    if (!t) { missing.push(b); continue; }
    flush();
    lines.push(`<!-- block_id: ${b.block_id}; pdf_page: ${b.page ?? ""} -->`, "");
    if (b.section === "注释与附录") lines.push(`**作者原注（PDF 第 ${(b.pages || [b.page]).join("、")} 页）**`, "");
    if (bilingual) lines.push(b.source, "", "**译文**", "");
    lines.push(t.translation, "");
    for (const note of t.translator_notes || []) lines.push(`> 译注：${note.replace(/\n/g, "\n> ")}`, "");
    for (const question of t.source_questions || []) lines.push(`> 原文待核：${question.replace(/\n/g, "\n> ")}`, "");
  }
  flush();
  return lines.join("\n");
}

export async function writeTranslationDraft(directory, blocks, translations, manifest) {
  if (!translations.length) return;
  const files = { chinese: "06_zh/translation-draft.md", bilingual: "05_bilingual/translation-draft.md" };
  for (const [kind, file] of Object.entries(files)) await writeText(path.join(directory, file), draftMarkdown(blocks, translations, { bilingual: kind === "bilingual" }));
  const ids = new Set(translations.map((t) => t.block_id));
  manifest.draft = { updatedAt: new Date().toISOString(), translatedUnits: blocks.filter((b) => ids.has(b.block_id)).length,
    totalUnits: blocks.length, qaComplete: false, files };
  await writeJson(path.join(directory, "04_qa/translation-draft.json"), manifest.draft);
  for (const [kind, file] of Object.entries(files)) {
    manifest.outputs ||= {};
    if (!manifest.outputs[kind] || manifest.outputs[kind] === file) manifest.outputs[kind] = file;
  }
}
