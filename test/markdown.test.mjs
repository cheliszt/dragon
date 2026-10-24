import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChinese,
  chunkBlocks,
  parseStructuredMarkdown,
  splitMarkdownBlocks,
  structureMarkdown
} from "../src/markdown.mjs";

test("Markdown splitting preserves fenced code and tables", () => {
  const source = "# Title\n\nParagraph.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\n\nconst x = 1;\n```\n";
  const blocks = splitMarkdownBlocks(source);
  assert.equal(blocks.length, 4);
  assert.match(blocks[2], /\| 1 \| 2 \|/);
  assert.match(blocks[3], /const x = 1/);
});

test("Structured Markdown round trips block ids", () => {
  const structured = structureMarkdown("# Title\n\nFirst.\n\nSecond.");
  const blocks = parseStructuredMarkdown(structured);
  assert.deepEqual(blocks.map((item) => item.block_id), ["B000001", "B000002", "B000003"]);
  assert.equal(chunkBlocks(blocks, 20).length, 3);
});

test("Chinese output is mechanically derived from translations", () => {
  const blocks = [{ block_id: "B000001", source: "One" }];
  const output = buildChinese(blocks, [{ block_id: "B000001", translation: "一" }]);
  assert.match(output, /一/);
  assert.doesNotMatch(output, /One/);
});
