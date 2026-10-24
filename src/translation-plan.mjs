import { readingBlocks, reflowText, isAppendixHeading } from "./reading-text.mjs";
import { sha256 } from "./utils.mjs";
import { cleanSourceBlocks, applySourceCleanup } from "./source-cleanup.mjs";
import { classifySourceStructure } from "./source-structure.mjs";

export const TRANSLATION_PLAN_VERSION = 8;
const ending = /[.!?。！？]["'”’»）)\]]*(?:\d+|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|<sup\b[^>]*>\s*\d+\s*<\/sup>|\[\^[^\]]+\])?\s*$/u;
const abbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e)|\b[A-Z]|(?:\b[A-Za-z]\.)+[A-Za-z])\.["'”’]?\s*$/;

export function endsSentence(text) {
  return ending.test(text) && !abbreviation.test(text);
}

function isStructure(text, section) {
  if (["目录", "版权与出版信息"].includes(section)) return true;
  if (isAppendixHeading(text)) return true;
  if (section === '注释与附录' && (/^\d{1,2}:\d{2}\s/.test(text)
    || /^\d+月份$|^开始时间\s|^\d{4}年.*节目表$|^（版本[^）]*）$|^作者\s|^人物[：:]|^上场$|^快板剧|^河北人民广播电台.*活页|简称/.test(text)
    || /^优秀工作者.*事迹|^通报(?:时间|范围)[：:]|委员会.*通报$/.test(text))) return true;
  // A year or numbered reference inside a prose paragraph does not turn the page into a list.
  if (/^\s*(?:#{1,6}\s|```|~~~|\||[-*+]\s|\d{1,3}[.)]\s|!\[|>\s)/.test(text)) return true;
  if (/^\d+\s+\p{L}[^\n]{0,90}$/u.test(text) && !/[.!?。！？]/.test(text)) return true;
  if (/\b(?:A series edited by|Titles in this series)\b/i.test(text) && !ending.test(text)) return true;
  if (text.length < 1000 && (text.match(/\bby\s+[A-Z]/g) || []).length >= 2 && !ending.test(text)) return true;
  if (text.length < 200 && /\b(?:University Press|Publishing)\b/i.test(text) && /\d{4}$/.test(text)) return true;
  // Short title lines are barriers; ordinary prose fragments can cross page boundaries.
  return !text.includes("\n") && text.length < 100 && !/[.!?。！？,，;；:：]/.test(text)
    && (/^[\p{Lu}\d\s\p{P}]+$/u.test(text) || /[A-Z]/.test(text) && /^(?:[A-Z][\p{L}'’-]*|of|the|and|on|as|in|a|to)(?:\s+(?:[A-Z][\p{L}'’-]*|of|the|and|on|as|in|a|to))*$/u.test(text));
}

// Bibliographic punctuation inside a title/translation is not the end of an entry.
function openReferenceDelimiter(text) {
  return ['()', '（）', '“”', '「」'].some(([left, right]) =>
    [...text].filter(c => c === left).length > [...text].filter(c => c === right).length)
    || (text.match(/"/g) || []).length % 2 === 1;
}

export function referenceContinues(previous, next) {
  if (/^\s*(?:#{1,6}\s|```|~~~|\||!\[)/.test(next)) return false;
  // Explicit entry starts also protect entries whose final punctuation is missing.
  if (/^(?:[“"]|[—_]{2,}|\[\d+\]\s|[A-Z][\p{L}'’-]+,\s+(?:[A-Z]|[“"]))/u.test(next)) return false;
  if (openReferenceDelimiter(previous) && (!endsSentence(previous) || /^[a-z]/.test(next))) return true;
  return !endsSentence(previous) || /\b(?:eds?|vols?|nos?|pp?)\.$/i.test(previous.trim());
}

// The size limit is soft: one sentence is never cut to meet a request budget.
function sentenceCuts(text) {
  const segments = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)];
  const cuts = [];
  for (let i = 0; i < segments.length - 1; i++) {
    let end = segments[i + 1].index;
    // PDF footnote numbers belong to the preceding sentence, not its successor.
    const footnote = text.slice(end).match(/^(?:\d+|<sup\b[^>]*>\s*\d+\s*<\/sup>|\[\^[^\]]+\])(?=\s+[A-Z“"‘]|[A-Z“"‘])/);
    if (footnote) end += footnote[0].length;
    if (endsSentence(text.slice(0, end))) cuts.push(end);
  }
  return [...new Set([...cuts, text.length])];
}

export function completeSentenceParts(text) {
  if (!endsSentence(text)) return [text];
  let start = 0;
  return sentenceCuts(text).map((end) => { const part = text.slice(start, end); start = end; return part; });
}

export function buildTranslationPlan(blocks, maxChars = 4500, { pdfLayout } = {}) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error("翻译分组大小必须是正数。");
  const classified = readingBlocks(blocks).map((b) => ({ ...b, text: reflowText(b.text, "en", b.section) }));
  const layout = classifySourceStructure(classified);
  if (pdfLayout) {
    if (pdfLayout.sourceDigest !== sha256(JSON.stringify(blocks))) throw new Error("PDF 版式证据与批准原文不匹配。");
    for (const note of pdfLayout.footnotes) layout.footnotes.set(note.block_id, note.noteId);
  }
  const cleanup = cleanSourceBlocks(classified.map((b) => layout.footnotes.has(b.block_id)
    ? { ...b, section: "注释与附录" } : b), { normalizeNoteCallouts: true });
  const originalById = new Map(classified.map((b) => [b.block_id, b.text]));
  const corpus = blocks.map((b) => b.source).join("\n");
  const omitted = [], sources = [], groups = [], boundaries = [], normalizations = [];
  const noteGroups = new Map();
  let current = null;
  for (const block of cleanup.blocks) {
    if (block.kind === "artifact") { omitted.push(block.block_id); continue; }
    const text = block.text;
    if (!text) { omitted.push(block.block_id); continue; }
    sources.push({ block_id: block.block_id, source: text, originalSource: text, beforeCleanup: originalById.get(block.block_id), page: block.page });
    const footnote = layout.footnotes.get(block.block_id);
    const folio = layout.structures.get(block.block_id) === "roman-page-label";
    if (footnote || folio) {
      // Keep the pending main-text sentence alive across page-foot notes. Notes have their
      // own groups and source spans; the main-text continuation never absorbs a citation.
      const groupId = footnote || `folio-${block.block_id}`;
      let note = noteGroups.get(groupId);
      if (!note) {
        note = { source: "", spans: [], section: footnote ? "注释与附录" : "排版与定位记录", scope: footnote ? "body" : "auxiliary", structural: true };
        noteGroups.set(groupId, note); groups.push(note);
      }
      if (note.source) note.source += " ";
      const start = note.source.length;
      note.source += text;
      note.spans.push({ block_id: block.block_id, page: block.page, start, end: note.source.length });
      continue;
    }
    const bibliography = block.section === '参考文献';
    const referenceContinuation = bibliography && current?.reference && referenceContinues(current.source, text);
    const structural = layout.structures.has(block.block_id) || (!referenceContinuation && (isStructure(text, block.section)
      || bibliography && text.length < 100 && /:\s*$/.test(text)));
    const trailingPart = current && (/\d\.$/.test(current.source) && /^\d/.test(text)
      || /^(?:[”’»）)\]]|\[\^\d+\])/.test(text));
    const splitWord = current && /[\p{L}][-\u00ad]$/u.test(current.source) && /^\p{Ll}/u.test(text);
    const hardStructure = (value) => /^\s*(?:#{1,6}\s|```|~~~|\||!\[)/.test(value);
    const speakerStart = block.section === '注释与附录' && /^[\p{Script=Han}\s]{0,5}[唱白][：:]/u.test(text);
    const listStart = /^[一二三四五六七八九十]+[、，．]\s*/.test(text);
    const continuation = current && current.section === block.section
      && (current.appendixListing && block.appendixListing
        || referenceContinuation && !layout.structures.has(block.block_id)
        || !bibliography && !current.structural && !structural && !speakerStart && !listStart && (!endsSentence(current.source) || trailingPart)
        || splitWord && !hardStructure(current.source) && !hardStructure(text));
    if (current) boundaries.push({ previousBlock: current.spans.at(-1).block_id, nextBlock: block.block_id,
      previousPage: current.lastPage, nextPage: block.page,
      tail: current.source.slice(-100), head: text.slice(0, 100), action: continuation ? "join" : "separate",
      reason: continuation ? referenceContinuation ? "reference-continuation" : "sentence-continuation"
        : current.structural || structural ? "structure" : current.section !== block.section ? "section"
          : speakerStart ? 'dialogue-boundary' : listStart ? 'list-entry' : "sentence-end" });
    if (!continuation) {
      current = { source: "", spans: [], section: block.section, scope: block.scope, structural: structural || bibliography,
        reference: bibliography && !structural, dialogue: speakerStart, listItem: listStart, appendixListing: block.appendixListing };
      groups.push(current);
    }
    if (continuation && /[\p{L}][-\u00ad]$/u.test(current.source) && /^\p{Ll}/u.test(text)) {
      const previous = sources.find((s) => s.block_id === current.spans.at(-1).block_id);
      const prefix = current.source.match(/([\p{L}]+)[-\u00ad]$/u)?.[1] || "";
      const suffix = text.match(/^\p{L}+/u)?.[0] || "";
      const compound = `${prefix}-${suffix}`;
      const joined = `${prefix}${suffix}`;
      const wordOccurs = (word) => new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, "u").test(corpus);
      // Preserve an attested lexical hyphen, but remove PDF line-break hyphens (ner- / vous).
      const keep = current.source.endsWith("-") && (prefix.toLowerCase() === "local" && suffix.toLowerCase() === "dialect"
        || !wordOccurs(joined) && (wordOccurs(compound)
          || /^(?:self|non|well|ill|anti|pre|post|cross|co|ex|half|quasi)$/i.test(prefix)));
      if (!keep) {
        normalizations.push({ block_id: previous.block_id, nextBlock: block.block_id, offset: previous.source.length - 1,
          removed: previous.source.at(-1), before: `${prefix}-${suffix}`, after: joined, reason: "line-break-hyphen" });
        previous.source = previous.source.slice(0, -1);
        current.source = current.source.slice(0, -1);
        current.spans.at(-1).end--;
      }
      boundaries.at(-1).reason = keep ? "hyphenated-compound" : "split-word";
    }
    const separator = !current.source || continuation && (trailingPart || ["split-word", "hyphenated-compound"].includes(boundaries.at(-1)?.reason)) ? "" : /[\u3400-\u9fff]$/.test(current.source) && /^[\u3400-\u9fff]/.test(text) ? "" : " ";
    current.source += separator;
    const start = current.source.length;
    current.source += text;
    current.spans.push({ block_id: block.block_id, page: block.page, start, end: current.source.length });
    current.lastPage = block.page;
  }
  const units = [];
  for (const group of groups) {
    const listIntroduction = /[:：]$/.test(group.source);
    const cuts = group.structural || group.dialogue || group.listItem ? [group.source.length] : sentenceCuts(group.source);
    let start = 0, last = 0;
    const emit = (end) => {
      const spans = group.spans.filter((s) => s.end > start && s.start < end).map((s) => ({
        block_id: s.block_id, page: s.page, start: Math.max(start, s.start) - s.start,
        end: Math.min(end, s.end) - s.start,
        unitStart: Math.max(start, s.start) - start, unitEnd: Math.min(end, s.end) - start
      }));
      const pages = [...new Set(spans.map((s) => s.page).filter(Boolean))];
      units.push({ block_id: `U${String(units.length + 1).padStart(6, "0")}`, source: group.source.slice(start, end),
        page: pages[0] || null, pages, section: group.section, scope: group.scope,
        kind: "content", translationUnit: true, sourceSpans: spans,
        boundaryKind: group.structural || group.dialogue || group.listItem || listIntroduction ? "structure" : endsSentence(group.source.slice(start, end)) ? "sentence"
          : /[.!?][”"]\s+—[^.!?]+$/.test(group.source.slice(start, end)) ? "attribution" : "fragment" });
      start = end;
    };
    for (const end of cuts) {
      if (end - start > maxChars && last > start) emit(last);
      last = end;
    }
    if (last > start) emit(last);
  }
  const plan = { schemaVersion: TRANSLATION_PLAN_VERSION, maxChars, ...(pdfLayout ? { pdfLayout } : {}), sourceBlockIds: blocks.map((b) => b.block_id),
    sourceDigest: sha256(JSON.stringify(blocks)), sources, omittedLayoutBlockIds: omitted, units, boundaries, normalizations,
    layoutClassifications: [...layout.structures].map(([block_id, reason]) => ({ block_id, reason }))
      .concat([...layout.footnotes].map(([block_id, noteId]) => ({ block_id, reason: "page-footnote", noteId }))),
    sourceCleanup: { version: cleanup.version, removals: cleanup.removals, normalizations: cleanup.normalizations, callouts: cleanup.callouts, uncertain: cleanup.uncertain,
      layoutOmissions: classified.filter((b) => b.kind === "artifact" && b.text).map((b) => ({ block_id: b.block_id, page: b.page,
        removed: b.text, reason: "repeated-running-heading" })) } };
  return { ...plan, version: sha256(JSON.stringify(plan)) };
}

export function validatePlanCoverage(plan) {
  for (const source of plan.sources) {
    if (source.beforeCleanup !== undefined) {
      try {
        if (applySourceCleanup(source.beforeCleanup, {
          removals: (plan.sourceCleanup?.removals || []).filter((r) => r.block_id === source.block_id),
          normalizations: (plan.sourceCleanup?.normalizations || []).filter((r) => r.block_id === source.block_id)
        }) !== source.originalSource) return false;
      } catch { return false; }
    }
    if (source.originalSource === undefined) continue;
    let expected = source.originalSource;
    for (const change of (plan.normalizations || []).filter((n) => n.block_id === source.block_id).sort((a, b) => b.offset - a.offset)) {
      if (!/[-\u00ad]/.test(change.removed) || expected[change.offset] !== change.removed) return false;
      expected = expected.slice(0, change.offset) + expected.slice(change.offset + 1);
    }
    if (source.source !== expected) return false;
  }
  const byId = new Map(plan.sources.map((s) => [s.block_id, s.source]));
  const positions = new Map(plan.sources.map((s) => [s.block_id, 0]));
  for (const unit of plan.units) {
    let cursor = 0;
    for (const span of unit.sourceSpans) {
      if (positions.get(span.block_id) !== span.start || span.end <= span.start
        || span.unitStart < cursor || span.unitEnd > unit.source.length || span.unitEnd <= span.unitStart
        || /\S/.test(unit.source.slice(cursor, span.unitStart))
        || unit.source.slice(span.unitStart, span.unitEnd) !== byId.get(span.block_id)?.slice(span.start, span.end)) return false;
      positions.set(span.block_id, span.end);
      cursor = span.unitEnd;
    }
    if (/\S/.test(unit.source.slice(cursor))) return false;
  }
  return plan.sources.every((s) => positions.get(s.block_id) === s.source.length)
    && plan.sourceBlockIds.every((id) => byId.has(id) !== plan.omittedLayoutBlockIds.includes(id));
}

export function validateSentenceBoundaries(plan) {
  return plan.units.every((unit) => unit.boundaryKind === "structure" || unit.boundaryKind === "attribution"
    || unit.boundaryKind === "sentence" && endsSentence(unit.source))
    && !plan.boundaries.some((b) => b.action === "separate" && (b.reason === "sentence-end" && !endsSentence(b.tail)
      || /[\p{L}][-\u00ad]$/u.test(b.tail) && /^\p{Ll}/u.test(b.head)));
}

export function blocksForTranslationRun(sourceBlocks, manifest) {
  if (!manifest.openai?.translationPlan) return sourceBlocks;
  const expected = manifest.openai.translationPlan;
  const plan = buildTranslationPlan(sourceBlocks, expected.maxChars, { pdfLayout: manifest.source?.pdfLayout });
  if (plan.version !== expected.version || !validatePlanCoverage(plan)) throw new Error("翻译单元版本不匹配，请重新运行翻译；不能将旧译文套入新分组。");
  return plan.units;
}
