import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { documentParagraphs, exportPdf, exportWord } from "../src/document-export.mjs";

test("document export removes workflow and Markdown markers while retaining notes and references", async () => {
  const source = `<!-- block_id: B000001 -->\n<!-- pdf_page: 3 -->\n<!-- pdf_pages: 3, 4 -->\n# 研究标题\n\n这是一段 **译文**，包含 [引文](https://example.org/source) 和 [1]。\n\n> **作者原注 1**\n> 注释内容。\n\n- 列表条目\n`;
  const paragraphs = documentParagraphs(source);
  assert.deepEqual(paragraphs.map((p) => p.text), ["研究标题", "这是一段 译文，包含 引文 (https://example.org/source) 和 [1]。", "作者原注 1", "注释内容。", "- 列表条目"]);
  const word = await exportWord(source);
  assert.equal(word.subarray(0, 2).toString(), "PK");
  const xml = await (await JSZip.loadAsync(word)).file("word/document.xml").async("string");
  assert.match(xml, /研究标题/);
  assert.match(xml, /注释内容/);
  assert.doesNotMatch(xml, /block_id|pdf_page|\*\*/);
  const pdf = await exportPdf(source);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  const parsed = await task.promise;
  const page = await parsed.getPage(1);
  const text = (await page.getTextContent()).items.map((item) => item.str).join("");
  assert.match(text, /研究标题/);
  assert.match(text, /注释内容/);
  assert.doesNotMatch(text, /block_id|pdf_page/);
  await task.destroy();
});
