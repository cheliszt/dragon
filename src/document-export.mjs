import { existsSync } from "node:fs";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { cleanEditorialText } from "./reading-text.mjs";

function plainText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:em|strong|sup|sub|span)\b[^>]*>/gi, "")
    .replace(/(?<!\\)\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(?<!\\)__([^_\n]+)__/g, "$1")
    .replace(/(?<!\\)\*([^*\n]+)\*/g, "$1")
    .replace(/(?<!\\)_([^_\n]+)_/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+.!>])/g, "$1")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " "
    })[entity]);
}

export function documentParagraphs(markdown) {
  const lines = cleanEditorialText(String(markdown).replace(/<!--\s*pdf_pages\s*:[^>\n]*(?:>|$)/gim, "")).split("\n");
  const paragraphs = [];
  let prose = [];
  let fenced = false;
  const flush = () => {
    if (prose.length) paragraphs.push({ type: "body", text: plainText(prose.join("\n")).trim() });
    prose = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { flush(); fenced = !fenced; continue; }
    if (!line) { flush(); continue; }
    if (fenced) { paragraphs.push({ type: "quote", text: raw }); continue; }
    if (/^[-*_]{3,}$/.test(line)) { flush(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flush(); paragraphs.push({ type: "heading", level: heading[1].length, text: plainText(heading[2]) }); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flush(); paragraphs.push({ type: "quote", text: plainText(quote[1]) }); continue; }
    const list = line.match(/^([-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (list) { flush(); paragraphs.push({ type: "list", text: `${list[1].trim()} ${plainText(list[2])}` }); continue; }
    if (/^\|.*\|$/.test(line)) {
      flush();
      if (!/^\|[\s:|-]+\|$/.test(line)) paragraphs.push({ type: "list", text: line.slice(1, -1).split("|").map((s) => plainText(s.trim())).join("    ") });
      continue;
    }
    prose.push(line);
  }
  flush();
  return paragraphs.filter((p) => p.text);
}

export async function exportWord(markdown) {
  const sections = documentParagraphs(markdown).map((item) => new Paragraph({
    children: [new TextRun(item.text)],
    ...(item.type === "heading" ? { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Math.min(item.level - 1, 2)] } : {}),
    spacing: { after: item.type === "heading" ? 160 : 200, line: 360 },
    ...(item.type === "quote" ? { indent: { left: 360 } } : {}),
    ...(item.type === "list" ? { indent: { left: 240 } } : {})
  }));
  const doc = new Document({
    styles: { default: { document: { run: { font: "SimSun", size: 24 }, paragraph: { spacing: { line: 360 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: sections }]
  });
  return Packer.toBuffer(doc);
}

function pdfFont() {
  const candidates = process.platform === "win32" ? [
    "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/ARIALUNI.ttf"
  ] : process.platform === "darwin" ? [
    "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
  ] : [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
  ];
  const font = candidates.find(existsSync);
  if (!font) throw new Error("未找到可用于 PDF 的中文字体，请安装中文字体后重试。");
  return font;
}

export async function exportPdf(markdown) {
  const paragraphs = documentParagraphs(markdown);
  const font = pdfFont();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 64, right: 62, bottom: 64, left: 62 }, info: { Title: "译文稿" } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      doc.font(font);
      for (const item of paragraphs) {
        const heading = item.type === "heading";
        const size = heading ? Math.max(13, 19 - item.level * 2) : item.type === "quote" ? 10 : 11;
        const left = item.type === "quote" ? 18 : item.type === "list" ? 12 : 0;
        doc.fontSize(size).fillColor(heading ? "#263d36" : "#202725");
        doc.text(item.text, doc.page.margins.left + left, undefined, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right - left,
          lineGap: 5, paragraphGap: heading ? 10 : 9
        });
      }
      doc.end();
    } catch (error) { reject(error); doc.end(); }
  });
}
