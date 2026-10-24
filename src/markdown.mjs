import { normalizeText } from "./utils.mjs";
import { readingBlocks, reflowText } from "./reading-text.mjs";

export function splitMarkdownBlocks(markdown) {
  const lines = normalizeText(markdown).split("\n");
  const blocks = [];
  let current = [];
  let fence = null;

  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = null;
      current.push(line);
      continue;
    }

    if (!fence && /^#{1,6}\s+/.test(line)) {
      flush();
      current.push(line);
      flush();
      continue;
    }

    if (!fence && !line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

export function structureMarkdown(markdown) {
  return splitMarkdownBlocks(markdown)
    .map((content, index) => `<!-- block_id: B${String(index + 1).padStart(6, "0")} -->\n\n${content}`)
    .join("\n\n").trimEnd() + "\n";
}

export function parseStructuredMarkdown(markdown) {
  const pattern = /<!--\s*block_id:\s*([A-Za-z0-9._:-]+)\s*-->/g;
  const matches = [...markdown.matchAll(pattern)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
    return { block_id: match[1], source: markdown.slice(start, end).trim() };
  }).filter((block) => block.source);
}

export function chunkBlocks(blocks, maxChars) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const block of blocks) {
    const blockLength = block.source.length + block.block_id.length + 40;
    if (current.length && length + blockLength > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(block);
    length += blockLength;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function buildBilingual(blocks, translations) {
  const translated = new Map(translations.map((item) => [item.block_id, item.translation]));
  return readingBlocks(blocks).filter((b) => b.kind !== "artifact").map((block) =>
    `${translations.find((t) => t.block_id === block.block_id)?.languagePolicy ? block.source : reflowText(block.text, "en", block.section)}\n\n${translations.find((t) => t.block_id === block.block_id)?.languagePolicy ? translated.get(block.block_id) : reflowText(translated.get(block.block_id) || "[缺少对应译文]", "zh", block.section)}`
  ).join("\n\n---\n\n") + "\n";
}

export function buildChinese(blocks, translations) {
  const translated = new Map(translations.map((item) => [item.block_id, item.translation]));
  return readingBlocks(blocks).filter((b) => b.kind !== "artifact").map((block) =>
    translations.find((t) => t.block_id === block.block_id)?.languagePolicy ? translated.get(block.block_id) : reflowText(translated.get(block.block_id) || "[缺少对应译文]", "zh", block.section)
  ).filter(Boolean).join("\n\n") + "\n";
}
