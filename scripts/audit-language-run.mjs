import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { readJson, sha256, sha256File, writeJson } from "../src/utils.mjs";
import { validateLanguageAnalysis, shouldPreserve } from "../src/languages.mjs";
import { validatePlanCoverage, validateSentenceBoundaries } from "../src/translation-plan.mjs";

const dir = path.resolve(process.argv[2]);
const m = await readJson(path.join(dir, "manifest.json"));
const folder = path.join(dir, m.openai.chunkDirectory);
const plan = await readJson(path.join(folder, "../translation-plan.json"));
const errors = [], pending = [];
const check = (ok, message) => { if (!ok) errors.push(message); };
check(await sha256File(path.join(dir, m.source.approvedFile)) === m.source.approvedSha256, "批准原文哈希不符");
check(await sha256File(path.join(dir, m.source.originalFile)) === m.source.sha256, "原始 PDF 哈希不符");
check(validatePlanCoverage(plan) && validateSentenceBoundaries(plan), "翻译单元覆盖或句末检查失败");
check(m.languages.targetLanguage === "zh-Hans" && JSON.stringify(m.languages.sourceLanguages) === JSON.stringify(["en", "pinyin", "zh-Hans"]), "项目语种不是指定的英语、拼音、简体中文到简体中文");
const detected = new Map();
for (const file of (await readdir(path.join(folder, "requests"))).filter((f) => /^languages-.*\.json$/.test(f))) {
  const result = await readJson(path.join(folder, "requests", file));
  for (const u of result.value?.units || []) {
    const b = plan.units.find((b) => b.block_id === u.block_id);
    if (!b) { errors.push(`检测有未知单元 ${u.block_id}`); continue; }
    try { validateLanguageAnalysis([b], { units: [u] }); detected.set(u.block_id, u); }
    catch { errors.push(`语言检测原文覆盖不符 ${u.block_id}`); }
  }
}
const translations = new Map();
for (const file of (await readdir(folder)).filter((f) => /^\d{4}-translated\.json$/.test(f))) {
  for (const t of (await readJson(path.join(folder, file))).translations || []) {
    check(!translations.has(t.block_id), `重复译文单元 ${t.block_id}`);
    translations.set(t.block_id, t);
  }
}
let pinyin = 0, preserved = 0;
for (const b of plan.units) {
  const d = detected.get(b.block_id), t = translations.get(b.block_id);
  if (!d) { pending.push(`检测:${b.block_id}`); continue; }
  if (!t) { pending.push(`翻译:${b.block_id}`); continue; }
  check(JSON.stringify(t.languageSegments) === JSON.stringify(d.segments), `译文语种依据不符 ${b.block_id}`);
  for (const s of d.segments) {
    if (shouldPreserve(s, m.languages)) { preserved++; check(t.translation.includes(s.text), `需保留文字被改动 ${b.block_id}:${s.text}`); }
    else if (s.language === "pinyin") {
      pinyin++;
      check((t.translator_notes || []).some((n) => n.includes(s.text.trim())), `拼音缺少译注 ${b.block_id}:${s.text}`);
      check(t.translation.includes(`（${s.text.trim()}）`) || t.translation.includes(s.text) && (t.translator_notes || []).some((n) => n.includes(s.text.trim()) && /未译|未转换|原样保留/.test(n)), `拼音缺少原拼音括注或保留说明 ${b.block_id}:${s.text}`);
      check(t.language_reviews?.some((q) => q.category === "pinyin_review" && q.source_quote === s.text), `拼音缺少人工质检项 ${b.block_id}:${s.text}`);
    }
  }
}
let qa, reading;
try { qa = await readJson(path.join(dir, "04_qa/final.json")); reading = await readJson(path.join(dir, "04_qa/review-document.json")); }
catch (e) { if (e.code !== "ENOENT") throw e; pending.push("最终译稿和质检尚未发布"); }
if (qa && reading) {
  check(qa.sourceSha256 === m.source.approvedSha256, "质检对应原文版本不符");
  check(JSON.stringify(reading.languages) === JSON.stringify(m.languages), "阅读稿语种不符");
  for (const [id, t] of translations) {
    check(reading.units.some((u) => u.blockId === id && u.target === t.translation), `阅读稿译文不符 ${id}`);
    for (const r of t.language_reviews || []) check(qa.issues.some((q) => q.block_id === id && q.category === r.category && q.source_quote === r.source_quote), `最终报告缺少语言待核项 ${id}`);
  }
  const map = await readJson(path.join(dir, "04_qa/reading-output-map.json"));
  for (const key of ["chinese", "bilingual"]) check(sha256(await readFile(path.join(dir, m.outputs[key]))) === map.outputs[`${key}Sha256`], `导出稿哈希不符 ${key}`);
}
if (!["completed", "qa_failed"].includes(m.status)) pending.push(`项目状态:${m.status}`);
const report = { checkedAt: new Date().toISOString(), projectId: m.projectId, status: errors.length ? "failed" : pending.length ? "incomplete" : "verified",
  languages: m.languages, sourceUnits: plan.units.length, detectedUnits: detected.size, translatedUnits: translations.size,
  pinyinChecks: pinyin, preservedSegments: preserved, qaSummary: qa?.summary, errors, pendingCount: pending.length, pendingExamples: pending.slice(0, 5) };
await writeJson(path.join(dir, "04_qa/language-run-audit.json"), report);
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
