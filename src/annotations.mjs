import { parseStructuredMarkdown, structureMarkdown } from "./markdown.mjs";
import { readingBlocks, reflowText } from "./reading-text.mjs";
import { cleanSourceBlocks } from "./source-cleanup.mjs";
import { sha256 } from "./utils.mjs";

const headingKey = (text) => text.replace(/^#+\s*/, "").replace(/^chapter\s+/i, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const noteHeading = /^(?:#{1,6}\s*)?(?:notes|endnotes|footnotes|注释|尾注|脚注|註釋)$/i;
const chapterHeading = /^(?:#{1,6}\s*)?(?:chapter\s+)?(\d{1,3})[.、]?\s+(.{2,90})$/i;

export function extractAuthorNotes(markdown) {
  const blocks = readingBlocks(parseStructuredMarkdown(markdown.includes("<!-- block_id:") ? markdown : structureMarkdown(markdown)));
  const notes = [], chapters = [], issues = [];
  const bodyHeadings = new Set();
  for (const b of blocks) {
    if (noteHeading.test(b.text.trim())) break;
    if (b.kind !== "artifact" && !b.text.includes("\n") && b.text.length < 100
      && (chapterHeading.test(b.text) || /^#{1,6}\s/.test(b.text) || /^[A-Z][A-Z\s-]+$/.test(b.text))) bodyHeadings.add(headingKey(b.text));
  }
  let inNotes = false, chapter = "global", current = null;
  const finish = () => {
    if (!current) return;
    current.source = reflowText(current.lines.join("\n"), "en", "注释与附录");
    delete current.lines;
    if (notes.some((n) => n.id === current.id)) issues.push({ type: "duplicate-note", id: current.id });
    else notes.push(current);
    current = null;
  };
  for (const b of blocks) {
    if (b.kind === "artifact") continue;
    const text = b.text.trim();
    if (noteHeading.test(text)) { finish(); inNotes = true; continue; }
    if (/^(?:#{1,6}\s*)?(?:bibliography|references|参考文献|參考文獻)$/i.test(text)) { finish(); inNotes = false; continue; }
    const h = text.match(chapterHeading);
    if (inNotes && /^[^\n]+$/.test(text) && bodyHeadings.has(headingKey(text))) {
      finish(); chapter = h ? `chapter-${h[1]}` : `section-${sha256(headingKey(text)).slice(0, 12)}`;
      chapters.push({ id: chapter, title: text, key: headingKey(text) }); continue;
    }
    for (const line of text.split("\n")) {
      const explicit = line.match(/^\s*\[\^([^\]]+)\]:\s*(.*)$/);
      const numeric = inNotes && line.match(/^\s*(\d{1,3})[.)、]?\s+(\S.*)$/);
      const match = explicit || numeric;
      if (match) {
        finish();
        const label = match[1];
        const scope = explicit ? "markdown" : chapter;
        current = { id: `author-${scope}-${encodeURIComponent(label)}`, label, chapter: scope, page: b.page,
          sourceBlocks: [b.block_id], lines: [match[2]], kind: "author" };
      } else if (current && (inNotes || /^\s/.test(line))) {
        current.lines.push(line); if (!current.sourceBlocks.includes(b.block_id)) current.sourceBlocks.push(b.block_id);
      } else if (!inNotes) finish();
    }
  }
  finish();
  return { notes, chapters, issues };
}

function translatedNotes(model, catalog) {
  let inNotes = false, chapter = "global";
  const groups = new Map();
  for (const u of model.units) {
    if (noteHeading.test(u.source.trim())) { inNotes = true; continue; }
    if (inNotes && u.section === "参考文献") break;
    if (!inNotes || u.artifact) continue;
    const h = catalog.chapters.find((c) => c.key === headingKey(u.source));
    if (h) { chapter = h.id; continue; }
    const group = groups.get(chapter) || [];
    group.push(u.target); groups.set(chapter, group);
  }
  const result = new Map();
  for (const [scope, parts] of groups) {
    const text = parts.join("\n\n");
    const expected = catalog.notes.filter((n) => n.chapter === scope);
    const positions = [];
    let cursor = 0, valid = true;
    for (const note of expected) {
      const pattern = new RegExp(`(?:^|[\\n。！？.!?][\"”’'*)\\]]*\\s*)(${note.label})[.)、]?\\s+(?=\\S)`, "gu");
      const matches = [...text.matchAll(pattern)].filter((m) => m.index + m[0].lastIndexOf(m[1]) >= cursor);
      if (matches.length !== 1) { valid = false; break; }
      const m = matches[0], start = m.index + m[0].lastIndexOf(m[1]);
      positions.push({ note, start, content: m.index + m[0].length }); cursor = m.index + m[0].length;
    }
    if (!valid) continue;
    positions.forEach((p, i) => result.set(p.note.id, text.slice(p.content, positions[i + 1]?.start ?? text.length).trim()));
  }
  return result;
}

export function buildAnnotations(markdown, model, { footnotes = [] } = {}) {
  const catalog = extractAuthorNotes(markdown);
  for (const n of footnotes) catalog.notes.push({ ...n, id: `author-${n.chapter}-${n.label}`, sourceBlocks: [] });
  const existing = translatedNotes(model, catalog);
  const notes = catalog.notes.map((n) => ({ ...n, originalSource: n.source, translation: existing.get(n.id) || "",
    translationOrigin: existing.has(n.id) ? "existing-translation" : "pending" }));
  const classified = model.units.map((u) => ({ block_id: u.id, text: u.source || "", page: u.page, section: u.section, kind: u.artifact ? "artifact" : "content" }));
  const detected = cleanSourceBlocks(classified);
  const all = [...detected.callouts, ...detected.uncertain.map((r) => ({ ...r, removed: r.text, number: Number(r.text) }))];
  const references = [], unresolved = [];
  let chapter = "global", inNotes = false;
  for (const unit of model.units) {
    if (noteHeading.test(unit.source?.trim() || "")) { inNotes = true; continue; }
    if (inNotes || unit.artifact) continue;
    const h = catalog.chapters.find((c) => c.key === headingKey(unit.source));
    if (h) chapter = h.id;
    const refs = all.filter((r) => r.block_id === unit.id);
    const compact = (s) => s.replace(/[\s\u00ad-]/g, "");
    for (const m of (unit.source || "").matchAll(/(?<=[\p{L})”])(\d{1,3})(?=\s|[,.!?;:]|$)/gu)) {
      if (refs.some((r) => r.offset === m.index)) continue;
      if (notes.some((n) => n.chapter.startsWith("page-") && n.label === m[1]
        && (unit.pages || [unit.page]).includes(n.page) && n.referenceContexts?.some((q) => compact(unit.source.slice(0, m.index)).endsWith(compact(q))))) {
        refs.push({ offset: m.index, removed: m[0], label: m[1], explicit: true });
      }
    }
    for (const m of (unit.source || "").matchAll(/\[\^([^\]]+)\](?!:)|<sup\b[^>]*>(\d+)<\/sup>|\[(\d{1,3})\]/g)) {
      if (!refs.some((r) => r.offset === m.index)) refs.push({ offset: m.index, removed: m[0], label: m[1] || m[2] || m[3], explicit: true });
    }
    for (const r of refs.sort((a, b) => a.offset - b.offset)) {
      const label = r.label || String(r.number);
      const local = notes.filter((n) => n.chapter.startsWith("page-") && (unit.pages || [unit.page]).includes(n.page) && n.label === label);
      const matchedLocal = local.filter((n) => n.referenceContexts?.some((q) => compact(unit.source.slice(0, r.offset)).endsWith(compact(q))));
      const note = notes.find((n) => n.chapter === "markdown" && n.label === label)
        || (local.length === 1 ? local[0] : matchedLocal.length === 1 ? matchedLocal[0] : null)
        || notes.find((n) => n.chapter === chapter && n.label === label);
      if (!note) { unresolved.push({ unitId: unit.id, chapter, label, offset: r.offset }); continue; }
      const after = unit.source.slice(0, r.offset);
      references.push({ id: `ref-${sha256(`${unit.id}:${r.offset}:${note.id}`).slice(0, 16)}`, unitId: unit.id, noteId: note.id, label,
        sourceStart: r.offset, sourceEnd: r.offset + r.removed.length, sourceQuote: after.slice(-120),
        targetQuote: null, placement: "pending" });
    }
  }
  return { schemaVersion: 1, version: model.version, sourceHash: model.sourceHash, notes, references,
    issues: catalog.issues, unresolved, paragraphMaps: {}, createdAt: new Date().toISOString() };
}

export function annotationText(text, references) {
  const positions = references.filter((r) => Number.isInteger(r.targetOffset)).sort((a, b) => b.targetOffset - a.targetOffset);
  for (const r of positions) {
    if (r.existingMarker) continue;
    text = text.slice(0, r.targetOffset) + `[${r.label}]` + text.slice(r.targetOffset);
  }
  return text;
}

// Move exact anchors across a local edit; positions inside a rewritten span remain unverified.
export function rebaseAnnotations(catalog, unitId, before, after) {
  const next = structuredClone(catalog);
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const move = (quote) => {
    if (!quote) return quote;
    const at = before.indexOf(quote);
    if (at < 0 || before.indexOf(quote, at + 1) >= 0) return quote;
    const offset = at + quote.length;
    const end = offset <= start ? offset : offset >= oldEnd ? offset + newEnd - oldEnd : null;
    if (end === null) return null;
    for (let size = Math.max(70, quote.length); ; size *= 2) {
      const result = after.slice(Math.max(0, end - size), end);
      if (result && after.indexOf(result) === after.lastIndexOf(result)) return result;
      if (size >= end) return null;
    }
  };
  for (const r of next.references.filter((r) => r.unitId === unitId)) r.targetQuote = move(r.targetQuote);
  const map = next.paragraphMaps?.[unitId];
  if (map) {
    for (const p of map.paragraphs) p.targetQuote = move(p.targetQuote);
    map.targetHash = sha256(after);
  }
  return next;
}

export function attachAnnotations(model, catalog, changes = { revision: 0, notes: {}, translatorNotes: [] }) {
  const authorNotePlacement = changes.authorNotePlacement || "paragraph";
  const notes = catalog.notes.map((n) => ({ ...n, ...changes.notes?.[n.id] }));
  const noteMap = new Map(notes.map((n) => [n.id, n]));
  const units = model.units.map((unit) => {
    const references = catalog.references.filter((r) => r.unitId === unit.id).map((r) => {
      const quote = r.targetQuote;
      const at = quote ? unit.target.indexOf(quote) : -1;
      const unique = at >= 0 && unit.target.indexOf(quote, at + 1) < 0;
      const offset = unique ? at + quote.length : null;
      const suffix = offset === null ? "" : unit.target.slice(offset);
      const escaped = r.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const existingMarker = offset !== null && new RegExp(`^(?:\\[\\^?${escaped}\\]|${escaped})(?!\\d)`).test(suffix);
      return { ...r, targetOffset: offset, existingMarker, note: noteMap.get(r.noteId), inlineNote: authorNotePlacement !== "source", placement: offset === null ? "needs-alignment" : "verified" };
    });
    const paragraphMap = catalog.paragraphMaps?.[unit.id] || null;
    const ends = paragraphMap?.paragraphs.map((p) => {
      const at = p.targetQuote ? unit.target.indexOf(p.targetQuote) : -1;
      return at >= 0 && unit.target.indexOf(p.targetQuote, at + 1) < 0 ? at + p.targetQuote.length : -1;
    });
    const invalidParagraphs = ends && (ends.some((end, i) => end <= (ends[i - 1] || 0)) || /\S/.test(unit.target.slice(ends.at(-1) || 0)));
    return { ...unit, authorNotes: references, translatorNotes: (changes.translatorNotes || []).filter((n) => n.unitId === unit.id),
      annotationNeedsAlignment: references.some((r) => r.targetOffset === null) || Boolean(invalidParagraphs),
      paragraphMap };
  });
  return { ...model, units, annotations: { version: catalog.version, revision: changes.revision || 0, notes: notes.length,
    authorNotePlacement,
    references: catalog.references.length, unresolved: catalog.unresolved, issues: catalog.issues } };
}

export function annotatedMarkdown(model, { bilingual = false } = {}) {
  return model.units.filter((u) => !u.artifact).map((u) => {
    return annotationParagraphs(u).map((p) => {
      const target = annotationText(p.target, p.references.map((r) => ({ ...r, targetOffset: Number.isInteger(r.targetOffset) ? r.targetOffset - p.targetStart : null })));
      const body = bilingual ? `${p.source}\n\n${target}` : target;
      const notes = [...new Map(p.references.filter((r) => r.inlineNote !== false).map((r) => [r.noteId, r])).values()].map((r) =>
        `> **作者原注 ${r.label}**${bilingual ? `\n> ${r.note.source.replaceAll("\n", "\n> ")}` : ""}\n> ${(r.note.translation || "[原注待翻译]").replaceAll("\n", "\n> ")}`);
      const visibleNotes = model.languages?.targetLanguage === 'zh-Hans'
        ? p.translatorNotes.filter((n) => !/(?:拼音待人工审核|正文缺少原拼音括注|专名规则.{0,10}保留原文拼写)/.test(n.text))
        : p.translatorNotes;
      const translator = visibleNotes.map((n, i) => `> **译注 ${i + 1}**\n> ${n.text.replaceAll("\n", "\n> ")}`);
      return [body, ...notes, ...translator].join("\n\n");
    }).join("\n\n");
  }).join(bilingual ? "\n\n---\n\n" : "\n\n") + "\n";
}

export function annotationParagraphs(unit) {
  let parts = unit.paragraphMap?.paragraphs || [];
  let previous = 0;
  parts = parts.map((p) => {
    const at = unit.target.indexOf(p.targetQuote);
    const end = at >= 0 && unit.target.indexOf(p.targetQuote, at + 1) < 0 ? at + p.targetQuote.length : -1;
    const value = { ...p, targetStart: previous, targetEnd: end }; previous = end; return value;
  });
  if (!parts.length || parts.some((p) => p.targetEnd <= p.targetStart) || /\S/.test(unit.target.slice(parts.at(-1).targetEnd))) {
    parts = [{ id: "p1", sourceStart: 0, sourceEnd: unit.source.length, targetStart: 0, targetEnd: unit.target.length }];
  }
  return parts.map((p) => ({ ...p, source: unit.source.slice(p.sourceStart, p.sourceEnd), target: unit.target.slice(p.targetStart, p.targetEnd),
    references: (unit.authorNotes || []).filter((r) => r.sourceStart >= p.sourceStart && r.sourceStart < p.sourceEnd),
    translatorNotes: (unit.translatorNotes || []).filter((n) => n.paragraphId === p.id || parts.length === 1) }));
}
