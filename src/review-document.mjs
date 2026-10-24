import { readingBlocks, reflowText } from "./reading-text.mjs";
import { applyNumericPolicy } from "./numeric-qa.mjs";
import { sha256 } from "./utils.mjs";
import { completeSentenceParts, endsSentence } from "./translation-plan.mjs";

function quotes(text) {
  return [...text.matchAll(/[“「「‘]([^”」’\n]{2,240})[”」’]|"([^"\n]{2,240})"|`([^`\n]{2,240})`/g)].map((m) => m[1] || m[2] || m[3]);
}

function highlights(text, issue, side) {
  const precise = side === "source" ? issue.source_quote : issue.translation_quote;
  const candidates = precise ? [precise] : [...quotes(issue.description || ""), ...quotes(issue.recommendation || "")];
  const ranges = [];
  for (const quote of candidates) {
    const normalized = reflowText(quote, /[\u3400-\u9fff]/.test(quote) ? "zh" : "en");
    let start = -1;
    while (normalized && (start = text.indexOf(normalized, start + 1)) >= 0) ranges.push({ start, end: start + normalized.length, issueId: issue.id, exact: true });
  }
  return ranges;
}

function pairs(source, target) {
  const a = source.split(/\n\s*\n/), b = target.split(/\n\s*\n/);
  if (a.length === b.length && a.length > 1 && a.every(endsSentence)) return a.map((s, i) => [s, b[i]]);
  // A split is only safe when both sides have the same sentence count.
  if (source.length > 1300 || target.length > 650) {
    const split = (s, lang) => [...new Intl.Segmenter(lang, { granularity: "sentence" }).segment(s)].map((x) => x.segment);
    const left = completeSentenceParts(source), right = split(target, "zh");
    if (left.length === right.length && left.length > 1) {
      const result = [];
      let l = "", r = "";
      for (let i = 0; i < left.length; i++) {
        l += left[i]; r += right[i];
        if (l.length >= 800 || r.length >= 350 || i === left.length - 1) { result.push([l.trim(), r.trim()]); l = r = ""; }
      }
      return result;
    }
  }
  return [[source, target]];
}

export function buildReviewDocument(blocks, translations, report, { title = "双语审阅", sourceHash = "", languages } = {}) {
  const translated = new Map(translations.map((item) => [item.block_id, item.translation]));
  const classified = readingBlocks(blocks);
  const byId = new Map(classified.map((b) => [b.block_id, b]));
  const issues = applyNumericPolicy(report.issues || [], blocks, translations).map((raw, index) => {
    const ids = [...new Set(String(raw.block_id || "").match(/(?:B|U)\d+/g) || [])].filter((id) => byId.has(id));
    const metadataOnly = ids.length && ids.every((id) => byId.get(id).kind === "artifact");
    let recommendation = raw.recommendation || "";
    if (!recommendation || /人工复核该块并重新运行质检/.test(recommendation)) {
      recommendation = raw.category === "source_question" ? "对照本段、前后文及 PDF 原页确认所述疑点；确认后记录判断，再决定是否修改译文。"
        : raw.category === "numeric" ? "逐项对照高亮数值与译文；若只是汉字数字或单位写法不同，可标为无需修改。"
          : "结合下方说明核查本段用词及前后文，在审阅记录中保留判断。";
    }
    return { ...raw, id: `q-${index + 1}-${sha256(JSON.stringify(raw)).slice(0, 10)}`, blockIds: ids,
      scope: raw.category === "pinyin_review" || ids.some((id) => byId.get(id).scope === "body") ? "body" : "auxiliary",
      metadataOnly, recommendation,
      sourceQuotes: quotes(raw.description || "") };
  });
  const units = [];
  for (const block of classified) {
    const item = translations.find((t) => t.block_id === block.block_id);
    const source = item?.languagePolicy ? block.source : reflowText(block.text, "en", block.section);
    const target = item?.languagePolicy ? item.translation : reflowText(translated.get(block.block_id) || "", "zh", block.section);
    const attached = issues.filter((q) => q.blockIds.includes(block.block_id));
    if (block.kind === "artifact") {
      if (attached.length) units.push({ id: `${block.block_id}-0`, blockId: block.block_id, page: block.page, section: block.section,
        scope: "auxiliary", artifact: true, source: "已从读稿移除的排版或页面定位记录。", target: "不属于待翻译正文。",
        issueIds: attached.map((q) => q.id), sourceMarks: [], targetMarks: [] });
      continue;
    }
    // Planned units already have verified boundaries. Sentence counts alone do not
    // establish bilingual alignment and must not split a paragraph or citation again.
    const parts = block.translationUnit || item?.languagePolicy || item?.term_exceptions?.length ? [[source, target]] : pairs(source, target);
    const localized = attached.map((q) => ({ q, source: highlights(source, q, "source"), target: highlights(target, q, "target") }));
    for (const [index, [s, t]] of parts.entries()) {
      const own = localized.filter((x) => (!x.source.length && !x.target.length) || highlights(s, x.q, "source").length || highlights(t, x.q, "target").length);
      const sm = own.flatMap((x) => highlights(s, x.q, "source"));
      const tm = own.flatMap((x) => highlights(t, x.q, "target"));
      // No invented phrase locations: use a visibly distinguished paragraph-level highlight.
      for (const { q } of own.filter((x) => !x.source.length && !x.target.length && x.q.severity !== "note")) {
        if (s) sm.push({ start: 0, end: s.length, issueId: q.id, exact: false });
        if (t) tm.push({ start: 0, end: t.length, issueId: q.id, exact: false });
      }
      units.push({ id: `${block.block_id}-${index}`, blockId: block.block_id, page: block.page, pages: block.pages, section: block.section,
        termExceptions: item?.term_exceptions || [],
        scope: item?.language_reviews?.some((q) => q.category === "pinyin_review") ? "body" : block.scope,
        ...(item?.languagePolicy ? { languageSegments: item.languageSegments, languageReviews: item.language_reviews,
          translatorNotes: (item.translator_notes || []).map((text, n) => ({ id: `machine-${block.block_id}-${n}`, unitId: `${block.block_id}-${index}`, paragraphId: "p1", text, origin: "ai" })) } : {}),
        source: s, target: t, issueIds: own.map((x) => x.q.id), sourceMarks: sm, targetMarks: tm, part: index + 1, parts: parts.length });
    }
  }
  const represented = new Set(units.flatMap((u) => u.issueIds));
  const unplaced = issues.filter((q) => !represented.has(q.id));
  if (unplaced.length) units.push({ id: "document-issues", blockId: "", page: null, section: "全篇待定位", scope: "body", artifact: true,
    source: "这些问题未提供可定位的段落。", target: "请通过全文搜索和原件核对。", issueIds: unplaced.map((q) => q.id), sourceMarks: [], targetMarks: [] });
  const version = sha256(JSON.stringify({ sourceHash, units, issues, languages }));
  return { schemaVersion: 1, version, title, sourceHash, units, issues, languages, classification: "自动分组，可在审阅中调整；不改变原始质检结论。" };
}
