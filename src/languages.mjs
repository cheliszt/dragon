import path from "node:path";
import { readJson, writeJson, sha256, sleep } from "./utils.mjs";
import { transientError, retryDelay } from "./reliability.mjs";

export const LANGUAGE_POLICY = "selected-languages-v3-pinyin-ordinary-names";
export const LANGUAGE_NAMES = { "zh-Hans": "简体中文", "zh-Hant": "繁体中文", en: "英语", ja: "日语", ko: "韩语", pinyin: "汉语拼音" };
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export function languageSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("语言设置格式无效。");
  const sourceLanguages = value.sourceLanguages ?? ["en"];
  const targetLanguage = ({ "简体中文": "zh-Hans", "中文": "zh-Hans", "英语": "en" })[value.targetLanguage] || value.targetLanguage || "zh-Hans";
  if (!Array.isArray(sourceLanguages) || !sourceLanguages.length || sourceLanguages.some((x) => !Object.hasOwn(LANGUAGE_NAMES, x))) throw invalid("请至少选择一种有效源语言。");
  if (!["zh-Hans", "en"].includes(targetLanguage)) throw invalid("目标语言仅支持简体中文或英语。");
  return { sourceLanguages: [...new Set(sourceLanguages)].sort(), targetLanguage, languagePolicy: LANGUAGE_POLICY };
}
export function projectLanguages(manifest, config = {}) {
  return languageSettings(manifest.languages || { sourceLanguages: manifest.openai?.sourceLanguages || config.translation?.sourceLanguages, targetLanguage: manifest.openai?.targetLanguage || config.translation?.targetLanguage });
}
export function languageInstructions(context) {
  if (!context.languagePolicy) return "";
  const s = languageSettings(context);
  return `本任务源语言（仅翻译所选语种）：${s.sourceLanguages.map((x) => LANGUAGE_NAMES[x]).join("、")}。目标语言：${LANGUAGE_NAMES[s.targetLanguage]}。此设置优先于工作规程及风格文档的默认语种。
已有目标语言必须逐字保留；未选语言及未知语言原样保留。简体与繁体中文分开判断。英语和汉语拼音分开判断，不把普通英文词或其他拉丁字母文字无依据地判断为拼音。
目标为简体中文时，正文、脚注、文末参考文献中的汉语拼音及汉语专名罗马化均须查证并还原为简体字，不在汉字后括注拼音。地名使用可核实的现实地名，并登记到专有词表。人名须检索原文、全文首次全称及可靠资料，确认汉字；只写姓氏的简称须根据上下文对应到同一人的全名。机构名、文献名亦按核实的中文原名处理。经核对仍没有可核实汉字记录的普通民众姓名可保留完整原文拼音，须在专有词表注明人物身份、原文位置及待核依据；作者、广播从业者、机构人员和地名不适用此例外。除该例外外译文不保留拼音。不得凭读音猜造汉字；证据不足时在审阅记录中提出具体疑点，不将猜测当作定名。
目标为英语时，汉语拼音先结合语境理解再翻译。`;
}
const spanSchema = { type: "object", additionalProperties: false, properties: {
  text: { type: "string" }, language: { type: "string", enum: [...Object.keys(LANGUAGE_NAMES), "other", "unknown"] },
  reason: { type: "string" }
}, required: ["text", "language", "reason"] };
export const languageSchema = { type: "object", additionalProperties: false, properties: { units: {
  type: "array", items: { type: "object", additionalProperties: false, properties: {
    block_id: { type: "string" }, segments: { type: "array", items: spanSchema }
  }, required: ["block_id", "segments"] }
} }, required: ["units"] };
export const analysisInstructions = `你是学术材料语言检测和句段分析员。对每个现有翻译单元按自然句段标注语言，混合句内部按语言切换细分，提供 reason 说明语言证据。完整原文、邻近单元仅用于上下文理解。
原有单元边界、跨页接续和分组规则已经确定，不得改变、增删或移动 block_id，不得跨单元重新分组。单元内依据用户选择和实际语种理解句界，连续同语种按完整句子分段；混合语言句子再按语种切换细分，不把缩写或注号误作句界。标题、代码、表格等既有结构保持完整。不要翻译或修订。每个 segments.text 必须按顺序逐字复制，连空格、换行、标点、标记也必须保留；拼接后必须精确等于 source。
必须检测所有文字，包括未选语言，不能强行归入所选语种；未列出的语言标 other，证据不足标 unknown。标点和空白附属于邻近片段，代码、路径和纯排版标记标 unknown。简繁共用文字结合上下文判断，无法确定时保留。汉语拼音需要汉语语境依据，尤其无声调拼音，不能仅因使用拉丁字母就认定。已由汉语语境或全文证实的人名、地名、机构名、文献名及其简称，即使嵌在英语句中也标 pinyin，按完整专名划出片段；纯英语及非汉语罗马化专名仍按实际语种标注。`;

export function validateLanguageAnalysis(blocks, value) {
  if (!Array.isArray(value?.units) || value.units.length !== blocks.length || blocks.some((b, i) => {
    const u = value.units[i];
    return u?.block_id !== b.block_id || !Array.isArray(u.segments) || !u.segments.length
      || u.segments.some((s) => typeof s.text !== "string" || !s.text || ![...Object.keys(LANGUAGE_NAMES), "other", "unknown"].includes(s.language) || typeof s.reason !== "string")
      || u.segments.map((s) => s.text).join("") !== b.source;
  })) throw Object.assign(new Error("语言检测未逐字覆盖原文或单元顺序不符，未提交翻译。"), { code: "BLOCK_MISMATCH" });
}

export async function analyzeLanguages({ client, blocks, context, cacheDir, checkpoint = () => {}, onEvent = () => {}, maxAttempts = 4, sleepImpl = sleep }) {
  const key = sha256(JSON.stringify({ blocks, settings: languageSettings(context), model: client.model, baseUrl: client.baseUrl }));
  const file = path.join(cacheDir, `languages-${key}.json`);
  let saved;
  try { saved = await readJson(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (saved?.key === key) {
    try { validateLanguageAnalysis(blocks, saved.value); return saved.value; } catch {}
  }
  for (let attempt = 1; ; attempt++) {
    await checkpoint();
    await onEvent({ phase: "language-detection", state: "requesting", attempt, maxAttempts });
    try {
      const response = await client.analyzeLanguages(blocks, context);
      validateLanguageAnalysis(blocks, response.value);
      await writeJson(file, { key, ...response });
      return response.value;
    } catch (error) {
      const canSplit = ["BLOCK_MISMATCH", "INCOMPLETE_RESPONSE", "INVALID_RESPONSE", "REQUEST_TIMEOUT", "STREAM_IDLE_TIMEOUT", "STREAM_INTERRUPTED", "STREAM_FAILED"].includes(error.code) || [504, 524].includes(error.status);
      if (blocks.length > 1 && canSplit) {
        const middle = Math.ceil(blocks.length / 2), values = [];
        for (const subset of [blocks.slice(0, middle), blocks.slice(middle)]) values.push(await analyzeLanguages({ client, blocks: subset, context, cacheDir, checkpoint, onEvent, maxAttempts, sleepImpl }));
        const value = { units: values.flatMap((v) => v.units) };
        validateLanguageAnalysis(blocks, value);
        await writeJson(file, { key, value, assembledFromSplit: true });
        return value;
      }
      if (attempt >= maxAttempts || !(transientError(error) || ["BLOCK_MISMATCH", "INCOMPLETE_RESPONSE", "INVALID_RESPONSE"].includes(error.code))) throw error;
      await sleepImpl(retryDelay(error, attempt));
    }
  }
}

export const shouldPreserve = (segment, context) => segment.language === context.targetLanguage
  || !(context.sourceLanguages.includes(segment.language) || segment.language === "pinyin" && (context.targetLanguage === "zh-Hans" || context.sourceLanguages.some((s) => s.startsWith("zh-"))));
const containsOriginalPinyin = (translation, source) => {
  const value = source.trim();
  if (!value) return false;
  const occurs = (part) => new RegExp(`(?<![\\p{Script=Latin}])${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{Script=Latin}])`, "iu").test(translation);
  if (occurs(value)) return true;
  const words = value.match(/[\p{Script=Latin}]+/gu) || [];
  return words.length > 1 && words.some((word) => (word.length >= 4 || word.length >= 2 && /^\p{Lu}/u.test(word)) && occurs(word));
};
// Protected strings never reach the translation model as editable source. Exact tokens
// are checked before restoring the original strings, including repeated occurrences.
export function protectLanguages(blocks, context) {
  const protectedById = new Map();
  const masked = blocks.map((b) => {
    if (!b.languageSegments) throw new Error("缺少翻译前语言检测。");
    const protectedSpans = [];
    const prefix = `⟦KEEP_${sha256(b.source).slice(0, 16)}_`;
    if (b.source.includes(prefix)) throw new Error("原文与语言保护标记冲突。");
    const source = b.languageSegments.map((s, i) => {
      if (!shouldPreserve(s, context)) return s.text;
      const token = `${prefix}${i}⟧`;
      protectedSpans.push({ ...s, token }); return token;
    }).join("");
    protectedById.set(b.block_id, protectedSpans);
    return { ...b, source, languageSegments: undefined, languageAnalysis: b.languageSegments,
      readOnlyOriginal: b.source };
  });
  return { blocks: masked, protectedById };
}
export function restoreLanguages(blocks, translations, context, protectedById) {
  for (const b of blocks) {
    const t = translations.find((t) => t.block_id === b.block_id);
    if (!t || typeof t.translation !== "string") throw Object.assign(new Error("缺少对应译文。"), { code: "BLOCK_MISMATCH" });
    if ([t.source_questions, t.translator_notes].some((items) => !Array.isArray(items) || items.some((s) => typeof s !== "string"))) throw Object.assign(new Error("翻译响应的疑点或译注格式无效。"), { code: "BLOCK_MISMATCH" });
    const spans = protectedById.get(b.block_id);
    for (const { token } of spans) if (t.translation.split(token).length !== 2) throw Object.assign(new Error("模型改动或遗漏了保留文字的标记，译文未保存。"), { code: "BLOCK_MISMATCH" });
    const returned = t.translation.match(/⟦KEEP_[^⟧]*⟧/g) || [];
    if (returned.length !== spans.length || returned.some((token) => !spans.some((s) => s.token === token))) throw Object.assign(new Error("模型返回了无效的保留标记。"), { code: "BLOCK_MISMATCH" });
    const structural = spans.filter((s) => s.language === "unknown").map((s) => s.token);
    const returnedStructural = returned.filter((token) => structural.includes(token));
    if (returnedStructural.some((token, i) => token !== structural[i])) throw Object.assign(new Error("模型返回了乱序的注号或排版标记。"), { code: "BLOCK_MISMATCH" });
    for (const s of spans) t.translation = t.translation.replace(s.token, () => s.text);
    t.languagePolicy = LANGUAGE_POLICY;
    t.languageSegments = b.languageSegments;
    t.language_reviews = b.languageSegments.filter((s) => s.language === "unknown" || s.language === "pinyin" && !shouldPreserve(s, context) && (context.targetLanguage !== "zh-Hans" || containsOriginalPinyin(t.translation, s.text))).map((s) => ({
      category: s.language === "pinyin" ? "pinyin_review" : "language_uncertain", source_quote: s.text,
      description: s.language === "pinyin" ? `译文仍含汉语拼音专名：${s.text}。${s.reason}` : `语种不确定，已原样保留：${s.text}。${s.reason}`,
      recommendation: s.language === "pinyin" ? "检索原文及可靠资料，确认简体字写法和简称指代后替换；无可核实汉字记录的普通民众姓名可保留完整拼音并登记专有词表。" : "请核对原页、语言选择及保留内容。"
    }));
    if (context.targetLanguage !== "zh-Hans") for (const s of b.languageSegments.filter((s) => s.language === "pinyin" && !shouldPreserve(s, context))) {
      const original = s.text.trim();
      if (!t.translator_notes.some((note) => note.includes(original))) {
        const detail = "缺少说明原拼音及推定含义的译注；已保留译文。";
        t.translator_notes.push(`拼音待人工审核：${original}。${detail}`);
        t.language_reviews.find((r) => r.category === "pinyin_review" && r.source_quote === s.text).description += ` ${detail}`;
      }
    }
  }
  return translations;
}
