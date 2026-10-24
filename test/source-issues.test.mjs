import test from "node:test";
import assert from "node:assert/strict";
import { findSourceIssues, resolveSourceIssue } from "../web/source-issues.js";
import { parseStructuredMarkdown } from "../src/markdown.mjs";

const source = "<!-- block_id: B001313 -->\r\n\r\n<!-- pdf_page: 146; CHECK-SOURCE: 本页文字较少、乱码或提取失败，请对照原页核对 -->\r\n\r\n<!-- block_id: B001314 -->\r\n\r\n146\r\n\r\n<!-- block_id: B001935 -->\r\n\r\n<!-- pdf_page: 208; CHECK-SOURCE: 请核对 -->\r\n\r\n<!-- block_id: B001936 -->\r\n\r\n208\r\n";

test("issues identify PDF page, block, line and exact selection in long Unicode/CRLF drafts", () => {
  const text = "前文😀\r\n".repeat(8000) + source;
  const issues = findSourceIssues(text);
  assert.deepEqual(issues.map((i) => [i.page, i.blockId, i.line]), [[146, "B001313", 8003], [208, "B001935", 8011]]);
  for (const issue of issues) assert.equal(text.slice(issue.start, issue.end), "CHECK-SOURCE");
  assert.match(issues[0].reason, /本页文字较少/);
});

test("confirming successive warnings preserves every block, PDF page and source character", () => {
  const once = resolveSourceIssue(source, findSourceIssues(source)[0]);
  assert.equal(findSourceIssues(once).length, 1);
  assert.equal(findSourceIssues(once)[0].page, 208);
  assert.match(once, /<!-- pdf_page: 146 -->/);
  const twice = resolveSourceIssue(once, findSourceIssues(once)[0]);
  assert.equal(findSourceIssues(twice).length, 0);
  assert.equal(twice, source.replace(/; CHECK-SOURCE:[^\r\n]*?(?= -->)/g, ""));
  assert.deepEqual(parseStructuredMarkdown(twice).map((b) => b.block_id), parseStructuredMarkdown(source).map((b) => b.block_id));
});

test("all approval marker types are found, including unknown pages and repeated markers", () => {
  const text = "TODO: first. UNCERTAIN second. CHECK-SOURCE third. NOTODO TODOLOGY uncertain\n<!-- pdf_page: 7 -->\n<!-- block_id: B2 -->\nTODO last.";
  const issues = findSourceIssues(text);
  assert.equal(issues.length, 4);
  assert.equal(issues[0].page, null);
  assert.equal(issues[3].page, 7);
  assert.equal(issues[3].blockId, "B2");
  assert.equal(resolveSourceIssue(text, issues[1]), text.replace("UNCERTAIN", ""));
  assert.throws(() => resolveSourceIssue("changed " + text, issues[1]), /原文已变化/);
});

test("unrecognized warning annotations do not consume adjacent metadata or other markers", () => {
  for (const text of [
    "<!-- pdf_page: 2; CHECK-SOURCE: reason; bbox: 123 -->\nBody.",
    "<!-- pdf_page: 2; CHECK-SOURCE: TODO verify -->\nBody.",
    "Body CHECK-SOURCE: uncertain wording.\nMore source."
  ]) {
    assert.equal(resolveSourceIssue(text, findSourceIssues(text)[0]), text.replace("CHECK-SOURCE", ""));
  }
});
