import test from "node:test";
import assert from "node:assert/strict";
import { cleanEditorialText, reflowText, readingBlocks } from "../src/reading-text.mjs";
import { buildChinese, buildBilingual } from "../src/markdown.mjs";
import { buildReviewDocument } from "../src/review-document.mjs";

test("reader removes complete, damaged, and escaped internal tags without deleting adjacent prose", () => {
  assert.equal(cleanEditorialText('<a id="b000011"></a>\n<!-- block_id: B000011 -->\n<!-- pdf_page: 9; 本页文字较少、乱码或提取失败，请对照原页核对 -->\n正文'), "正文");
  assert.equal(cleanEditorialText('<!-- pdf_page: 4 >\n段落'), "段落");
  assert.equal(cleanEditorialText('<!-- pdf_page: 4 -->正文'), "正文");
  assert.equal(cleanEditorialText('&lt;!-- pdf_page: 4 --&gt;\n内容'), "内容");
  assert.equal(cleanEditorialText('<!-- pdf_page: 4;\n内容'), "内容");
  assert.equal(cleanEditorialText('x < 5，实际 <em>强调</em>'), 'x < 5，实际 <em>强调</em>');
});

test("Chinese soft wraps join while paragraphs, headings, lists, tables and code survive", () => {
  assert.equal(reflowText('她吸了一小撮，分量大得惊人。那点量足以让我\n掉进 K 洞，而我可不想在厕所隔间里去那里。我们\n聊了一会儿。'), '她吸了一小撮，分量大得惊人。那点量足以让我掉进 K 洞，而我可不想在厕所隔间里去那里。我们聊了一会儿。');
  assert.equal(reflowText('一个\n段落。\n\n第二\n段落。'), '一个段落。\n\n第二段落。');
  const markdown = '# 标题\n\n- 项目一\n- 项目二\n\n| A | B |\n|---|---|\n\n```js\nlet x = 1;\nlet y = 2;\n```';
  assert.equal(reflowText(markdown), markdown);
  assert.equal(reflowText('OpenAI\nAPI 可用。'), 'OpenAI API 可用。');
  assert.equal(reflowText('The com-\nmunity dances.', 'en'), 'The community dances.');
});

test("contents, main text and bibliography remain primary; copyright and running heads are auxiliary", () => {
  const content = ['© All rights reserved', 'CONTENTS', '1 Rave as Practice 1', '2 Xeno-euphoria 11', '1 Rave as Practice', 'A paragraph.', 'Rave as Practice 3', 'Other text.', 'Rave as Practice 5', 'Other text.', 'Rave as Practice 7', 'BIBLIOGRAPHY', 'Acker, Kathy. A book.'];
  const blocks = content.map((source, i) => ({ block_id: `B${i}`, source }));
  const read = readingBlocks(blocks);
  assert.equal(read[0].scope, 'auxiliary');
  for (const index of [1, 2, 3, 4, 5, 11, 12]) { assert.equal(read[index].scope, 'body'); assert.equal(read[index].kind, 'content'); }
  for (const index of [6, 8, 10]) assert.equal(read[index].kind, 'artifact');
});

test("readable exports have no block labels and issue contexts highlight literal quotes on both sides", () => {
  const blocks = [{ block_id: 'B1', source: '<!-- pdf_page: 5 -->' }, { block_id: 'B2', source: 'A temporary life.' }, { block_id: 'B3', source: 'Next paragraph.' }];
  const translations = [{ block_id: 'B1', translation: '<!-- pdf_page: 5; 残留 -->' }, { block_id: 'B2', translation: '临时性\n生活。' }, { block_id: 'B3', translation: '下一段。' }];
  const report = { issues: [
    { block_id: 'B1', severity: 'blocking', category: 'metadata', description: '页码注释错误' },
    { block_id: 'B2/B3', severity: 'blocking', category: 'meaning', description: '“temporary life”译成“临时性生活”有歧义。', recommendation: '改用“暂时的生活形态”。' },
    { block_id: 'B3', severity: 'warning', category: 'context', description: '需要核对跨段语境。' }
  ] };
  assert.equal(buildChinese(blocks, translations), '临时性生活。\n\n下一段。\n');
  assert.doesNotMatch(buildBilingual(blocks, translations), /block_id|pdf_page|\*\*原文|\*\*译文/);
  const model = buildReviewDocument(blocks, translations, report);
  const unit = model.units.find((u) => u.blockId === 'B2');
  assert.equal(unit.page, 5);
  assert.equal(unit.source.slice(unit.sourceMarks[0].start, unit.sourceMarks[0].end), 'temporary life');
  assert.equal(unit.target.slice(unit.targetMarks[0].start, unit.targetMarks[0].end), '临时性生活');
  assert.equal(model.issues[0].scope, 'auxiliary');
  assert.equal(model.units.find((u) => u.blockId === 'B3').sourceMarks.some((m) => !m.exact), true);
  assert.equal(new Set(model.units.flatMap((u) => u.issueIds)).size, report.issues.length);
});

test("long aligned paragraphs split only when sentence correspondence is available", () => {
  const source = Array.from({ length: 12 }, (_, i) => `Sentence ${i} ${'word '.repeat(30)}.`).join(' ');
  const target = Array.from({ length: 12 }, (_, i) => `第${i}句${'内容'.repeat(30)}。`).join('');
  const model = buildReviewDocument([{ block_id: 'B1', source }], [{ block_id: 'B1', translation: target }], { issues: [] });
  assert.ok(model.units.length > 1);
  assert.equal(model.units.map((u) => u.source).join(' '), source);
  assert.equal(model.units.map((u) => u.target).join(''), target);
});

test("reader does not turn matching blank lines inside a sentence into independent editing units", () => {
  const model = buildReviewDocument([{ block_id: 'B1', source: 'He entered the\n\nroom quietly.' }],
    [{ block_id: 'B1', translation: '他走进了\n\n房间。' }], { issues: [] });
  assert.equal(model.units.length, 1);
  assert.match(model.units[0].source, /entered the[\s\S]*room quietly\./);
});
