export function cleanEditorialText(value = "") {
  return value.replace(/\r\n?/g, "\n")
    .replace(/\\?&lt;([\s\S]*?)\\?&gt;/g, (all, body) => /^(?:!--\s*(?:pdf_page|block_id)|\/?a\b)/i.test(body) ? `<${body}>` : all)
    .replace(/<a\s+id=["']b\d+["']\s*>\s*<\/a>/gi, "")
    .replace(/<!--\s*(?:block_id|pdf_page)\s*:[^>\n]*(?:>|$)/gim, "")
    .replace(/^\s*\[(?:本页无可提取文字|本页提取失败)\]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// Only soft line endings in prose are joined. Structural Markdown remains on its own lines.
export function reflowText(value, language = "zh", section = "正文") {
  const lines = cleanEditorialText(value).split("\n");
  const out = [];
  let paragraph = "";
  let fence = false;
  const flush = () => { if (paragraph) out.push(paragraph); paragraph = ""; };
  const structural = (line) => /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|\||!\[|[-*_]{3,}\s*$)/.test(line);
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fence = !fence; out.push(raw); continue; }
    if (fence) { out.push(raw); continue; }
    if (!line) { flush(); if (out.at(-1) !== "") out.push(""); continue; }
    if (section === "目录") { flush(); out.push(line); continue; }
    if (section === "参考文献" && /^[A-Z][\p{L}'’-]+,\s+(?:[A-Z][\p{L}'’.-]*\s*){1,4}\./u.test(line)) { flush(); if (out.length) out.push(""); }
    if (structural(line)) { flush(); out.push(line); continue; }
    if (!paragraph) { paragraph = line; continue; }
    if (language === "en" && /[a-zA-Z]-$/.test(paragraph) && /^[a-z]/.test(line)) paragraph = paragraph.slice(0, -1) + line;
    else {
      const space = language === "en" || (/[A-Za-z0-9]$/.test(paragraph) && /^[A-Za-z0-9]/.test(line));
      paragraph += (space ? " " : "") + line;
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isAppendixHeading(text) {
  return text.length < 150 && !/\n|\.{3}|…/.test(text)
    && /^(?:(?:appendix|appendices|appendice)\b|附录)(?:\s|:|$)/i.test(text)
    && (text.match(/appendi(?:x|ces|ce)\b/gi) || []).length <= 1;
}

export function readingBlocks(blocks) {
  let page = null;
  let section = "正文";
  let appendixListPage;
  const frequencies = new Map();
  const headerKey = (s) => s.toLowerCase().replace(/\b(?:\d+|[ivxlcdm]+)\b/g, "").replace(/\s+/g, " ").trim();
  for (const b of blocks) {
    const text = cleanEditorialText(b.source);
    if (text.length < 110 && !text.includes("\n")) frequencies.set(headerKey(text), (frequencies.get(headerKey(text)) || 0) + 1);
  }
  return blocks.map((block) => {
    if (block.translationUnit) return { ...block, text: block.source, kind: "content" };
    page = Number(block.source.match(/pdf_page\s*:\s*(\d+)/i)?.[1]) || page;
    const text = cleanEditorialText(block.source);
    let kind = "content";
    if (!text) kind = "artifact";
    const running = text.length < 110 && !text.includes("\n") && (frequencies.get(headerKey(text)) || 0) >= 3
      && (/\s\d+$/.test(text) || /^(?:\d+|[ivxlcdm]+)\s+(?:Chapter|Bibliography|Notes|Glossary|Acknowledgments)\b/i.test(text));
    if (running && section !== "目录") kind = "artifact";
    if (kind === "content") {
      const heading = text.replace(/^#{1,6}\s+/, "");
      if (/^List of Appendices$/i.test(heading)) appendixListPage = page;
      if (/^(?:CONTENTS|TABLE OF CONTENTS|目录|目錄)$/i.test(heading)) section = "目录";
      else if (/^(?:ABSTRACT|摘要)$/i.test(heading)) section = "正文";
      else if (/^(?:BIBLIOGRAPHY|REFERENCES|参考文献|參考文獻)$/i.test(heading)) section = "参考文献";
      else if (/^(?:NOTES|GLOSSARY OF CONCEPTS|NOTES ON THE IMAGES|注释|註釋|术语表)$/i.test(heading)) section = "注释与附录";
      else if (section !== '目录' && appendixListPage !== page && isAppendixHeading(heading)) section = "注释与附录";
      else if (/^(?:ACKNOWLEDGMENTS|ACKNOWLEDGEMENTS|致谢|致謝)$/i.test(heading)) section = "致谢";
      else if (/^(?:MORE PRAISE|PRAISE FOR)/i.test(text)) section = "推荐语与出版信息";
      else if (/©|All rights reserved|Cataloging-in-\s*Publication|版权所有/.test(text)) section = "版权与出版信息";
      else if (/^\d+\s+\p{L}[^\n]{2,90}$/u.test(text) && !/\s(?:\d+|[ivxlcdm]+)$/i.test(text)) section = "正文";
    }
    const scope = kind === "artifact" || ["致谢", "推荐语与出版信息", "版权与出版信息"].includes(section) || /^\d+(?:\s+\d+)*$/.test(text) ? "auxiliary" : "body";
    return { ...block, page, section: kind === "artifact" ? "排版与定位记录" : section, kind, scope, text,
      ...(appendixListPage === page && isAppendixHeading(text) ? { appendixListing: true } : {}) };
  });
}
