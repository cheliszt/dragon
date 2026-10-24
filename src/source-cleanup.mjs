import { splitMarkdownBlocks } from "./markdown.mjs";
import { readingBlocks } from "./reading-text.mjs";

// Deletions are recorded against the unmodified input. Ambiguous numbers stay intact.
export const SOURCE_CLEANUP_VERSION = 3;

export function cleanSourceMarkdown(markdown) {
  const blocks = readingBlocks(splitMarkdownBlocks(markdown).map((source, i) => ({ block_id: `extract-${i + 1}`, source })));
  const result = cleanSourceBlocks(blocks.map((b) => ({ ...b, text: b.source })), { normalizeNoteCallouts: true });
  const layout = blocks.filter((b) => b.kind === "artifact" && b.text);
  const omitted = new Set(layout.map((b) => b.block_id));
  return { markdown: result.blocks.filter((b) => !omitted.has(b.block_id)).map((b) => b.text).filter((t) => t.trim()).join("\n\n") + "\n",
    audit: { version: result.version, callouts: result.callouts, normalizations: result.normalizations, removals: [...result.removals, ...layout.map((b) => ({ block_id: b.block_id, page: b.page,
      removed: b.source, reason: "repeated-running-heading" }))], uncertain: result.uncertain } };
}

export function applySourceRemovals(text, removals) {
  let end = text.length;
  for (const item of [...removals].sort((a, b) => b.offset - a.offset)) {
    const allowed = item.reason === "consecutive-note-callouts" ? /^\d{1,3}$/.test(item.removed)
      : item.reason === "explicit-note-callout" ? /^(?:<sup\b[^>]*>\s*\d{1,3}\s*<\/sup>|\[\^\d{1,3}\]|[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3})$/u.test(item.removed)
        : item.reason === "page-number-sequence" && /^\s*\d{1,4}\s*$/.test(item.removed);
    if (!allowed || ![undefined, "", " "].includes(item.replacement) || !Number.isInteger(item.offset) || item.offset < 0 || !item.removed
      || item.offset + item.removed.length > end || text.slice(item.offset, item.offset + item.removed.length) !== item.removed) {
      throw new Error("原文清理记录与原文不匹配。");
    }
    end = item.offset;
    text = text.slice(0, item.offset) + (item.replacement || "") + text.slice(item.offset + item.removed.length);
  }
  return text;
}

export function applySourceCleanup(text, { removals = [], normalizations = [] } = {}) {
  const edits = [...removals, ...normalizations].sort((a, b) => b.offset - a.offset);
  let end = text.length;
  for (const edit of edits) {
    if (!Number.isInteger(edit.offset) || edit.offset < 0 || !edit.removed || edit.offset + edit.removed.length > end
      || text.slice(edit.offset, edit.offset + edit.removed.length) !== edit.removed) throw new Error("原文清理记录与原文不匹配。");
    end = edit.offset;
    if (edit.reason !== "structured-note-callout") text = applySourceRemovals(text, [edit]);
    else {
      const digits = edit.removed.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String("⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c)));
      if (!/^(?:\d{1,3}|<sup\b[^>]*>\s*\d{1,3}\s*<\/sup>|\[\^\d{1,3}\])$/u.test(digits)
        || Number(digits.replace(/<[^>]*>/g, "").match(/\d+/)?.[0]) !== edit.number
        || ![`[^${edit.number}]`, `[^${edit.number}] `].includes(edit.replacement)) throw new Error("注释标记清理记录无效。");
      text = text.slice(0, edit.offset) + edit.replacement + text.slice(edit.offset + edit.removed.length);
    }
  }
  return text;
}

// Input blocks retain page/section metadata; this also works for legacy approved text.
export function cleanSourceBlocks(blocks, { removeNoteCallouts = false, normalizeNoteCallouts = false } = {}) {
  const candidates = [], removals = [], normalizations = [], uncertain = [];
  const add = (block, offset, removed, reason, extra = {}) => removals.push({
    block_id: block.block_id, page: block.page || null, offset, removed, reason,
    context: block.text.slice(Math.max(0, offset - 65), offset + removed.length + 65), ...extra
  });
  const folios = new Map();
  const pageContent = new Map();
  for (const b of blocks) {
    if (!b.page) continue;
    const value = pageContent.get(b.page) || { letters: 0, numbers: 0 };
    value.letters += (b.text.match(/\p{L}/gu) || []).length;
    if (/^\d{1,4}$/.test(b.text.trim())) value.numbers++;
    pageContent.set(b.page, value);
  }
  for (const b of blocks) {
    if (b.page && pageContent.get(b.page).letters >= 80 && pageContent.get(b.page).numbers === 1
      && /^\d{1,4}$/.test(b.text.trim()) && !["目录", "注释与附录", "参考文献"].includes(b.section)) {
      const delta = b.page - Number(b.text.trim());
      if (!folios.has(delta)) folios.set(delta, []);
      folios.get(delta).push(b);
    }
  }
  for (const group of folios.values()) {
    if (new Set(group.map((b) => b.page)).size >= 3) {
      for (const b of group) add(b, 0, b.text, "page-number-sequence");
    }
  }
  for (const [blockIndex, b] of blocks.entries()) {
    if (b.kind === "artifact") continue;
    if (["目录", "参考文献", "注释与附录", "版权与出版信息"].includes(b.section)) continue;
    let fence = false, offset = 0;
    for (const line of b.text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; offset += line.length + 1; continue; }
      if (fence || /^\s*(?:#{1,6}\s|\||[-*+]\s|\d+[.)]\s|\[\^\d+\]:|!\[)/.test(line)) { offset += line.length + 1; continue; }
      // No whitespace before a bare marker: 'paid 16' and numbered lists are not notes.
      const pattern = /[\p{L})\]][.!?。！？]["'”’»）)\]]*(<sup\b[^>]*>\s*\d{1,3}\s*<\/sup>|\[\^\d{1,3}\]|[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}|\d{1,3})(?=\s|[A-Z“‘]|$)/gu;
      for (const match of line.matchAll(pattern)) {
        const marker = match[1], index = offset + match.index + match[0].length - marker.length;
        const prefix = b.text.slice(Math.max(0, index - 40), index);
        if (/\b(?:Fig|Eq|No|Vol|pp|p|Art|Sec|Ch|Chapter|Section|Table)\.$/i.test(prefix)) continue;
        const localIndex = index - offset;
        const protectedRange = [...line.matchAll(/`[^`]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|\$[^$]+\$/g)]
          .some((m) => localIndex >= m.index && localIndex < m.index + m[0].length);
        if (protectedRange) continue;
        const explicit = !/^\d+$/.test(marker);
        const confirmed = b.noteCallouts?.some((c) => c.offset === index && c.removed === marker);
        const n = Number(marker.replace(/<[^>]*>/g, "").replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String("⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c))).match(/\d+/)?.[0]);
        if (!n) continue;
        const replacement = /[A-Z“‘]/.test(b.text[index + marker.length] || "") ? " " : "";
        candidates.push({ block: b, offset: index, removed: marker, number: n, explicit, confirmed, replacement });
      }
      offset += line.length + 1;
    }
    // A flattened superscript may begin the next PDF paragraph. It still belongs to the preceding sentence.
    const leading = b.text.match(/^(\d{1,3})(?=\s+[A-Z“‘])/u);
    const previous = blocks.slice(0, blockIndex).reverse().find((p) => p.kind !== "artifact" && p.text.trim());
    if (leading && /[.!?。！？]/.test(b.text) && previous?.section === b.section && /[\p{L})\]][.!?]["'”’»）)\]]*\s*$/u.test(previous.text)
      && !/\b(?:Fig|Eq|No|Vol|pp|p|Art|Sec|Ch|Chapter|Section|Table)\.\s*$/i.test(previous.text)) {
      candidates.push({ block: b, offset: 0, removed: leading[1], number: Number(leading[1]), explicit: false, leading: true, replacement: "" });
    }
  }
  const order = new Map(blocks.map((b, i) => [b.block_id, i]));
  candidates.sort((a, b) => order.get(a.block.block_id) - order.get(b.block.block_id) || a.offset - b.offset);
  // Require at least three consecutive callouts for flattened OCR/PDF numbers.
  const accepted = new Set();
  for (let start = 0; start < candidates.length;) {
    let end = start + 1;
    while (end < candidates.length && candidates[end].block.section === candidates[end - 1].block.section
      && candidates[end].number === candidates[end - 1].number + 1) end++;
    if (end - start >= 3 && candidates.slice(start, end).some((c) => !c.leading)) for (let i = start; i < end; i++) accepted.add(i);
    start = end;
  }
  const callouts = [];
  candidates.forEach((c, i) => {
    if (c.explicit || c.confirmed || accepted.has(i)) add(c.block, c.offset, c.removed,
      c.explicit ? "explicit-note-callout" : "consecutive-note-callouts", { number: c.number, replacement: c.replacement });
    else if (!c.leading) uncertain.push({ block_id: c.block.block_id, page: c.block.page || null, offset: c.offset,
      text: c.removed, reason: "insufficient-note-evidence" });
  });
  for (let i = removals.length - 1; i >= 0; i--) {
    if (removals[i].reason.includes("note-callout")) {
      callouts.unshift(removals[i]);
      if (normalizeNoteCallouts && !removeNoteCallouts && removals[i].removed !== `[^${removals[i].number}]`) {
        normalizations.unshift({ ...removals[i], evidence: removals[i].reason, reason: "structured-note-callout",
          replacement: `[^${removals[i].number}]${removals[i].replacement || ""}` });
      }
      if (!removeNoteCallouts) removals.splice(i, 1);
    }
  }
  const cleaned = blocks.map((b) => ({ ...b, text: applySourceCleanup(b.text, {
    removals: removals.filter((r) => r.block_id === b.block_id), normalizations: normalizations.filter((r) => r.block_id === b.block_id)
  }) }));
  return { version: SOURCE_CLEANUP_VERSION, blocks: cleaned, removals, normalizations, callouts, uncertain };
}

// Request-level defense also covers legacy review text, without rewriting the saved manuscript.
export function prepareAiSources(blocks) {
  const classified = readingBlocks(blocks);
  const input = blocks.map((b, i) => ({ ...classified[i], ...b, text: b.source,
    page: b.page ?? classified[i].page, section: b.section ?? classified[i].section }));
  const cleanup = cleanSourceBlocks(input, { normalizeNoteCallouts: true });
  return { blocks: blocks.map((b, i) => ({ ...b, source: cleanup.blocks[i].text })),
    audit: { version: cleanup.version, removals: cleanup.removals, normalizations: cleanup.normalizations,
      callouts: cleanup.callouts, uncertain: cleanup.uncertain } };
}

// Map exact AI quotations back to the saved review source, including legacy flattened callouts.
export function restoreSourceQuote(quote, original, cleaned, audit, blockId) {
  if (!quote || original.includes(quote)) return quote;
  const start = cleaned.indexOf(quote);
  if (start < 0 || cleaned.indexOf(quote, start + 1) >= 0) return "";
  const edits = [...audit.removals, ...audit.normalizations].filter((r) => r.block_id === blockId).sort((a, b) => a.offset - b.offset);
  const map = (offset, end) => {
    let delta = 0;
    for (const edit of edits) {
      const at = edit.offset + delta, length = (edit.replacement || "").length;
      if (offset < at) break;
      if (offset < at + length) return edit.offset + (end ? edit.removed.length : 0);
      delta += length - edit.removed.length;
    }
    return offset - delta;
  };
  return original.slice(map(start, false), map(start + quote.length, true));
}

export function cleanReviewSources(model) {
  const result = cleanSourceBlocks(model.units.map((u, i) => ({ ...u, block_id: u.id || `review-${i}`, text: u.source || "", kind: u.artifact ? "artifact" : "content" })));
  return { ...model, sourceCleanup: { version: result.version,
    removals: result.removals, callouts: result.callouts, uncertain: result.uncertain },
    units: model.units.map((u, i) => ({ ...u, noteCallouts: result.callouts.filter((c) => c.block_id === (u.id || `review-${i}`)),
      ...(result.blocks[i].text === (u.source || "") ? {} : { source: result.blocks[i].text, originalSource: u.source, sourceMarks: [] }) })) };
}

// A small raised number immediately following sentence punctuation is an author callout, not a folio.
export function normalizePdfCallouts(pages) {
  const normalizations = [];
  return { pages: pages.map((page) => {
    let previous;
    const items = page.items.map((item, index) => {
      if (!item.str?.trim()) return item;
      const height = Math.abs(item.height || item.transform?.[3] || 10);
      const number = item.str.trim();
      const raised = previous && item.transform[5] - previous.item.transform[5];
      const gap = previous && item.transform[4] - previous.item.transform[4] - previous.item.width;
      if (/^[1-9]\d{0,2}$/.test(number) && previous && height < previous.height * 0.88
        && raised > previous.height * 0.08 && raised < previous.height * 0.75
        && gap > -previous.height * 0.25 && gap < previous.height * 0.8
        && /[\p{L})\]][.!?]["'”’»）)\]]*\s*$/u.test(previous.item.str)
        && !/\b(?:Fig|Eq|No|Vol|pp|p|Art|Sec|Ch|Chapter|Section|Table)\.\s*$/i.test(previous.item.str)) {
        const replacement = `[^${number}]`;
        normalizations.push({ page: page.page, itemIndex: index, removed: item.str, replacement,
          number: Number(number), reason: "pdf-superscript-callout", x: item.transform[4], y: item.transform[5],
          context: previous.item.str.slice(-100) });
        return { ...item, str: replacement, height: previous.height,
          transform: item.transform.map((value, i) => i === 5 ? previous.item.transform[5] : value) };
      }
      previous = { item, height };
      return item;
    });
    return { ...page, items };
  }), normalizations };
}

// Remove repeated marginal lines using position AND repetition, never position alone.
export function cleanPdfMargins(pages) {
  const signatures = new Map(), linesByPage = [];
  for (const page of pages) {
    const lines = [];
    const letters = page.items.reduce((sum, item) => sum + (item.str?.match(/\p{L}/gu) || []).length, 0);
    const [x0, y0, x1, y1] = page.view;
    const height = y1 - y0, width = x1 - x0;
    for (const [index, item] of page.items.entries()) {
      if (!item.str?.trim()) continue;
      const y = item.transform?.[5], h = Math.abs(item.height || item.transform?.[3] || 10);
      const band = item.transform[4] + item.width < x0 + width * 0.10 ? "left"
        : item.transform[4] > x1 - width * 0.10 ? "right" : "body";
      const line = lines.find((l) => l.band === band && Math.abs(l.y - y) < Math.min(l.h, h) * 0.3);
      if (line) { line.items.push({ item, index }); line.h = Math.max(line.h, h); }
      else lines.push({ y, h, band, items: [{ item, index }] });
    }
    for (const line of lines) {
      line.items.sort((a, b) => a.item.transform[4] - b.item.transform[4]);
      line.text = line.items.map(({ item }) => item.str).join(" ").trim();
      const left = Math.min(...line.items.map(({ item }) => item.transform[4]));
      const right = Math.max(...line.items.map(({ item }) => item.transform[4] + item.width));
      const edge = line.y < y0 + height * 0.10 ? "bottom" : line.y > y0 + height * 0.94 ? "top"
        : right < x0 + width * 0.10 ? "left" : left > x1 - width * 0.10 ? "right" : null;
      if (letters < 80 || !edge || line.text.length > 100 || /[.!?。！？]$/.test(line.text)) continue;
      if (["left", "right"].includes(edge)) {
        const neighbors = lines.filter((l) => l.band === "body" && Math.abs(l.y - line.y) < line.h);
        if (neighbors.some((l) => l.items.some(({ item }) => edge === "left"
          ? item.transform[4] - right < line.h * 2 : left - item.transform[4] - item.width < line.h * 2))) continue;
      }
      const normalized = line.text.toLowerCase().replace(/\b\d+\b/g, "#").replace(/\s+/g, " ");
      line.key = `${edge}:${Math.round((line.y - y0) / height * 50)}:${normalized}`;
      if (!signatures.has(line.key)) signatures.set(line.key, new Set());
      signatures.get(line.key).add(page.page);
    }
    linesByPage.push(lines);
  }
  const removals = [];
  const cleaned = pages.map((page, i) => {
    const rejected = new Set();
    for (const line of linesByPage[i]) {
      if (!line.key || signatures.get(line.key).size < 3) continue;
      for (const { index } of line.items) rejected.add(index);
      removals.push({ page: page.page, removed: line.text, reason: "repeated-pdf-margin",
        y: line.y, itemIndices: line.items.map((x) => x.index) });
    }
    return { ...page, items: page.items.filter((_, index) => !rejected.has(index)) };
  });
  return { pages: cleaned, removals };
}
