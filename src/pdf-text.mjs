import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPdfMargins, cleanSourceMarkdown, normalizePdfCallouts } from "./source-cleanup.mjs";
import { reflowText } from "./reading-text.mjs";

export const TEXT_LAYER_DEFAULTS = { minPageCharacters: 80, minCoverage: 0.85, maxBadCharacterRatio: 0.01 };

export function selectedPages(range, count) {
  if (!range) return Array.from({ length: count }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of range.split(",")) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    const start = Number(match?.[1]);
    const end = Number(match?.[2] || match?.[1]);
    if (!match || start < 1 || end < start || end > count) throw new Error(`页码范围无效：${part}；PDF 共 ${count} 页。`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function openPdf(filePath) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  return getDocument({
    data: new Uint8Array(await readFile(filePath)),
    standardFontDataUrl: path.join(packageRoot, "standard_fonts").replaceAll("\\", "/") + "/",
    cMapUrl: path.join(packageRoot, "cmaps").replaceAll("\\", "/") + "/",
    cMapPacked: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0
  });
}

function pageText(items, { paragraphs = false } = {}) {
  const lines = [];
  const leftEdges = items.filter((i) => i.str?.length > 25).map((i) => i.transform?.[4]).filter(Number.isFinite);
  const left = leftEdges.length ? Math.min(...leftEdges) : 0;
  let line = "";
  let previous;
  const flush = () => { if (line.trim()) lines.push(line.trimEnd()); line = ""; };
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (!item.str || !line && !item.str.trim()) { if (item.hasEOL) flush(); continue; }
    const y = item.transform?.[5];
    const height = Math.abs(item.height || item.transform?.[3] || 10);
    if (previous && Math.abs(y - previous.y) > Math.max(height, previous.height) * 0.5) {
      flush();
      const indent = (item.transform?.[4] || 0) - left;
      if (Math.abs(y - previous.y) > Math.max(height, previous.height) * 1.8
        || paragraphs && indent > height * 0.7 && indent < height * 3 && item.str?.trim()) lines.push("");
    }
    const gap = previous ? item.transform?.[4] - previous.right : 0;
    if (line && gap > height * 0.12 && !/\s$/.test(line) && !/^\s/.test(item.str)) line += " ";
    line += item.str;
    if (item.hasEOL) flush();
    previous = { y, height, right: (item.transform?.[4] || 0) + (item.width || 0) };
  }
  flush();
  return lines.join("\n").trim();
}

export function assessTextPages(pages, settings = {}) {
  const thresholds = { ...TEXT_LAYER_DEFAULTS, ...settings };
  const summaries = pages.map(({ page, text, error }) => {
    const chars = [...text];
    const characters = chars.filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
    const badCharacters = chars.filter((c) => /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\p{Co}]/u.test(c)).length;
    const badCharacterRatio = badCharacters / Math.max(1, chars.length);
    const usable = !error && characters >= thresholds.minPageCharacters && badCharacterRatio <= thresholds.maxBadCharacterRatio;
    return { page, characters, badCharacterRatio, usable, ...(error ? { error } : {}) };
  });
  const usablePages = summaries.filter((p) => p.usable).length;
  const coverage = usablePages / Math.max(1, pages.length);
  const totalCharacters = summaries.reduce((sum, p) => sum + p.characters, 0);
  const reviewPages = summaries.filter((p) => !p.usable).map((p) => p.page);
  return {
    thresholds, inspectedPages: pages.length, textPages: summaries.filter((p) => p.characters > 0).length,
    usablePages, coverage, totalCharacters, reviewPages, pages: summaries,
    suitable: pages.length > 0 && coverage >= thresholds.minCoverage && !summaries.some((p) => p.error)
  };
}

export function detectPdfFootnotes(pages) {
  const notes = [];
  for (const page of pages) {
    const height = page.view[3] - page.view[1], topFonts = new Map();
    for (const i of page.items) {
      if (i.transform?.[5] < page.view[1] + height * 0.5 || !i.str?.trim()) continue;
      const h = Math.round(Math.abs(i.height || i.transform?.[3]) * 10) / 10;
      topFonts.set(h, (topFonts.get(h) || 0) + (i.str.match(/\p{L}/gu) || []).length);
    }
    const body = [...topFonts].filter(([, count]) => count >= 80).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!body) continue;
    const small = page.items.filter((i) => i.str?.trim() && i.transform[5] < page.view[1] + height * 0.55
      && Math.abs(i.height || i.transform[3]) < body * 0.88);
    const lines = [];
    for (const item of small) {
      let line = lines.find((l) => Math.abs(l.y - item.transform[5]) < body * 0.3);
      if (!line) { line = { y: item.transform[5], items: [] }; lines.push(line); }
      line.items.push(item);
    }
    lines.sort((a, b) => b.y - a.y);
    let current;
    const finish = () => {
      if (current && (current.lines.join(" ").match(/\p{L}/gu) || []).length >= 2) {
        const text = reflowText(pageText(page.items), "en");
        const pattern = new RegExp(`(?<=[\\p{L})\\]][.!?][\"”’)]*)${current.label}(?!\\d)`, "gu");
        const referenceContexts = [...text.matchAll(pattern)].map((m) => text.slice(Math.max(0, m.index - 60), m.index));
        for (const [index, item] of page.items.entries()) {
          if (item.str?.trim() !== current.label || Math.abs(item.height || item.transform[3]) >= body * 0.9) continue;
          const previous = page.items.slice(0, index).reverse().find((i) => i.str?.trim() && Math.abs(i.height || i.transform[3]) >= body * 0.9);
          if (previous && item.transform[5] >= previous.transform[5] && item.transform[5] - previous.transform[5] < body * 0.6
            && Math.abs(item.transform[4] - previous.transform[4] - previous.width) < body * 0.8) referenceContexts.push(previous.str.slice(-60));
        }
        if (referenceContexts.length) notes.push({ ...current, source: reflowText(current.lines.join("\n"), "en", "注释与附录"), referenceContexts, lines: undefined });
      }
      current = null;
    };
    for (const line of lines) {
      line.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const text = line.items.map((i) => i.str).join(" ").trim();
      const m = text.match(/^(\d{1,3})[.)]?\s+(\p{L}.*)$/u);
      if (m) { finish(); current = { label: m[1], page: page.page, chapter: `page-${page.page}`, kind: "author", lines: [m[2]], evidence: "small-type-page-footnote" }; }
      else if (current && /\p{L}/u.test(text)) current.lines.push(text);
    }
    finish();
  }
  return notes;
}

export async function extractPdfText(filePath, { pageRanges, thresholds, onProgress = () => {} } = {}) {
  const task = await openPdf(filePath);
  try {
    const document = await task.promise;
    const numbers = selectedPages(pageRanges, document.numPages);
    const pages = [];
    for (const number of numbers) {
      try {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        pages.push({ page: number, text: pageText(content.items), items: content.items, view: page.view });
        page.cleanup();
      } catch (error) { pages.push({ page: number, text: "", items: [], view: [0, 0, 1, 1], error: error.message }); }
      if (pages.length === 1 || pages.length % 10 === 0 || pages.length === numbers.length) await onProgress({ extractedPages: pages.length, totalPages: numbers.length });
    }
    const report = { engine: "PDF.js", totalPages: document.numPages, ...assessTextPages(pages, thresholds) };
    const render = (values) => values.map(({ page, text, error }) => {
      const marker = report.reviewPages.includes(page) ? "; CHECK-SOURCE: 本页文字较少、乱码或提取失败，请对照原页核对" : "";
      return `<!-- pdf_page: ${page}${marker} -->\n\n${text || (error ? "[本页提取失败]" : "[本页无可提取文字]")}`;
    }).join("\n\n") + "\n";
    const rawMarkdown = render(pages);
    const margins = cleanPdfMargins(pages);
    const notes = normalizePdfCallouts(margins.pages);
    const cleaned = cleanSourceMarkdown(render(notes.pages.map((p) => ({ ...p, text: pageText(p.items, { paragraphs: true }) }))));
    const cleanup = { ...cleaned.audit, removals: [...margins.removals, ...cleaned.audit.removals],
      normalizations: [...notes.normalizations, ...cleaned.audit.normalizations] };
    return { report, rawMarkdown, markdown: cleaned.markdown, cleanup, footnotes: detectPdfFootnotes(margins.pages) };
  } finally { await task.destroy(); }
}
