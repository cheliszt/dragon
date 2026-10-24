import test from "node:test";
import assert from "node:assert/strict";
import { deterministicQa } from "../src/qa.mjs";
import { applyNumericPolicy, missingNumericValues } from "../src/numeric-qa.mjs";

test("QA reports missing blocks and numbers", () => {
  const blocks = [
    { block_id: "B1", source: "The value is 42%." },
    { block_id: "B2", source: "Second block." }
  ];
  const translations = [{ block_id: "B1", translation: "该数值很高。" }];
  const issues = deterministicQa(blocks, translations);
  assert.ok(issues.some((item) => item.category === "numeric" && item.severity === "note"));
  assert.ok(issues.some((item) => item.category === "missing_block"));
});

test("chapter words and ordinary words following numbers are not measurement units", () => {
  for (const [source, target] of [
    ["Chapter 1 Radio, Technopolitics", "第1章 广播、技术政治"],
    ["Chapter 1 Radio", "第一章 广播"],
    ["1.1 Revisiting Radio in Cold War China", "1.1 重访冷战时期中国的广播"],
    ["2.1 Introduction", "2.1 导论"],
    ["In 2012 to study radio.", "2012年研究广播。"],
    ["1949-1957", "1949—1957"]
  ]) assert.deepEqual(missingNumericValues(source, target), [], source);
});

test("decades compare by meaning across English suffix and Chinese century forms", () => {
  for (const source of ["the 1940s", "the 1940’s", "the 1940's"])
    for (const target of ["1940年代", "20世纪40年代", "二十世纪四十年代"])
      assert.deepEqual(missingNumericValues(source, target), [], `${source} / ${target}`);
  assert.deepEqual(missingNumericValues("1940s", "1950年代"), ["1940"]);
  assert.deepEqual(missingNumericValues("the 1950s and 1960s", "20世纪50年代和60年代"), []);
  assert.deepEqual(missingNumericValues("1940 s", "1940秒"), []);
  assert.deepEqual(missingNumericValues("42 kg", "42公斤"), []);
  assert.deepEqual(missingNumericValues("42 kg", "42公里"), ["42kg"]);
  assert.deepEqual(missingNumericValues("-5", "5"), ["-5"]);
});

test("old numeric false positives disappear; remaining AI findings become notes with stable IDs", () => {
  const issues = [
    { id: "title", block_id: "B1", category: "numeric", severity: "warning", description: "译文未发现这些原文数字或单位：1radio" },
    { id: "decade", block_id: "B2", category: "numeric", severity: "warning", description: "译文未发现这些原文数字或单位：1940s" },
    { id: "real", block_id: "B3", category: "numeric", severity: "blocking", description: "42误译成43" },
    { id: "meaning", block_id: "B3", category: "meaning", severity: "blocking", description: "否定漏译" }
  ];
  const updated = applyNumericPolicy(issues, [{ block_id: "B1", source: "1 Radio" }, { block_id: "B2", source: "1940s" }],
    [{ block_id: "B1", translation: "1 广播" }, { block_id: "B2", translation: "20世纪40年代" }]);
  assert.deepEqual(updated.map((q) => [q.id, q.severity]), [["real", "note"], ["meaning", "blocking"]]);
  assert.equal(issues[2].severity, "blocking", "archived source reports are not mutated");
});

test("QA separates author callouts from factual numbers and catches lost note links", () => {
  const blocks = [{ block_id: 'B1', source: 'In 2021, this happened.[^16] Another argument.[^17]' }];
  const clean = deterministicQa(blocks, [{ block_id: 'B1', translation: '这发生在2021年。[16]另一论点。[17]' }]);
  assert.equal(clean.length, 0);
  const issues = deterministicQa(blocks, [{ block_id: 'B1', translation: '这发生在某年。[16]另一论点。' }]);
  assert.ok(issues.some((q) => q.category === 'numeric' && q.description.includes('2021')));
  assert.ok(issues.some((q) => q.category === 'note_reference' && q.description.includes('17')));
  assert.ok(!issues.some((q) => q.category === 'numeric' && q.description.includes('16')));
});

test("QA promotes source questions to blocking issues", () => {
  const issues = deterministicQa(
    [{ block_id: "B1", source: "Ambiguous source." }],
    [{ block_id: "B1", translation: "有歧义的原文。", source_questions: ["末词无法辨认"], translator_notes: [] }]
  );
  assert.ok(issues.some((item) => item.category === "source_question" && item.severity === "blocking"));
});
