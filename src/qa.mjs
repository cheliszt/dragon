import { prepareAiSources } from "./source-cleanup.mjs";
import { missingNumericValues, applyNumericPolicy } from "./numeric-qa.mjs";

const PLACEHOLDER = /\b(?:TODO|CHECK-SOURCE|UNCERTAIN)\b|MISSING-TRANSLATION/g;

export function deterministicQa(blocks, translations) {
  const prepared = prepareAiSources(blocks);
  const issues = [];
  const sourceIds = new Set(blocks.map((block) => block.block_id));
  const translationMap = new Map();

  for (const item of translations) {
    if (translationMap.has(item.block_id)) {
      issues.push(issue("blocking", "duplicate_block", item.block_id, "译文块重复。"));
    }
    translationMap.set(item.block_id, item.translation);
    for (const review of item.language_reviews || []) issues.push({ severity: "warning", block_id: item.block_id, translation_quote: "", ...review });
    if (!sourceIds.has(item.block_id)) {
      issues.push(issue("blocking", "unknown_block", item.block_id, "译文包含源文中不存在的块。"));
    }
    for (const question of item.source_questions || []) {
      issues.push(issue("blocking", "source_question", item.block_id, question));
    }
    for (const note of item.translator_notes || []) {
      issues.push(issue("note", "translator_note", item.block_id, note));
    }
  }

  for (const block of prepared.blocks) {
    const translation = translationMap.get(block.block_id);
    if (!translation) {
      issues.push(issue("blocking", "missing_block", block.block_id, "缺少对应译文。"));
      continue;
    }
    const labels = [...new Set([...block.source.matchAll(/\[\^(\d{1,3})\](?!:)/g)].map((m) => m[1]))];
    let targetProse = translation;
    for (const label of labels) {
      const marker = new RegExp(`\\[\\^?${label}\\]|(?<=[。！？.!?][\"”’')）\\]]*)${label}(?!\\d)`, "gu");
      if (!marker.test(translation)) issues.push(issue("warning", "note_reference", block.block_id, `作者原注 ${label} 的关联标记未在译文中找到。`));
      targetProse = targetProse.replace(marker, "");
    }
    const prose = block.source.replace(/\[\^\d{1,3}\](?!:)/g, "");
    const missingNumbers = missingNumericValues(prose, targetProse);
    if (missingNumbers.length) {
      issues.push(issue("note", "numeric", block.block_id, `数值形式待核（最低级提示）：${missingNumbers.join(", ")}。字面差异不等于错译。`));
    }
    const placeholders = translation.match(PLACEHOLDER);
    if (placeholders?.length) {
      issues.push(issue("blocking", "placeholder", block.block_id, `译文残留占位符：${placeholders.join(", ")}`));
    }
  }
  return applyNumericPolicy(issues);
}

function issue(severity, category, block_id, description) {
  return { severity, category, block_id, description, recommendation: "人工复核该块并重新运行质检。" };
}

export function qaMarkdown(report) {
  const lines = [
    "# 质检报告",
    "",
    `- 状态：${report.status}`,
    `- 阻断问题：${report.summary.blocking}`,
    `- 警告：${report.summary.warning}`,
    `- 提示：${report.summary.note}`,
    "",
    "## 问题",
    ""
  ];
  if (!report.issues.length) lines.push("未发现问题。", "");
  for (const item of report.issues) {
    lines.push(`### [${item.severity}] ${item.block_id || "全局"} / ${item.category}`);
    lines.push("", item.description, "", `建议：${item.recommendation}`, "");
  }
  return lines.join("\n");
}
