export const NUMERIC_POLICY_VERSION = "numeric-note-v1";
export const numericInstructions = "数字质检规程：numeric 类别只能使用最低级 note（提示），不得计入 warning 或 blocking，不得阻断译文交付。标题前的 1、1.1、2.3 等是章节编号，不是数量或计量单位；不得把后面的 Radio、Introduction、Revisiting 等标题词拼成单位，不得因标题编号的等价排版或中文写法报告警告。1940s、1940’s、1940年代、20世纪40年代、二十世纪四十年代均可表示同一年代；s 是年代后缀，不是秒，语义一致时不报告问题。确有依据的数值或年代错译仍可作为 note 提示，不能仅凭字面形式不同认定错误。";

const unitAliases = new Map([
  ["%", "%"], ["％", "%"],
  ["km", "km"], ["千米", "km"], ["公里", "km"], ["cm", "cm"], ["厘米", "cm"],
  ["mm", "mm"], ["毫米", "mm"], ["m", "m"], ["米", "m"],
  ["kg", "kg"], ["千克", "kg"], ["公斤", "kg"], ["mg", "mg"], ["毫克", "mg"], ["g", "g"], ["克", "g"],
  ["ms", "ms"], ["毫秒", "ms"], ["s", "s"], ["秒", "s"], ["min", "min"], ["分钟", "min"],
  ["MHz", "MHz"], ["兆赫", "MHz"], ["kHz", "kHz"], ["千赫", "kHz"], ["Hz", "Hz"], ["赫兹", "Hz"],
  ["kW", "kW"], ["千瓦", "kW"], ["W", "W"], ["瓦", "W"]
]);
// Match known units only; an adjacent title or prose word is never a unit.
const UNIT = /^(?:\s*)(%|％|MHz|kHz|Hz|kW|W|km|cm|mm|kg|mg|ms|min|m|g|s)(?![A-Za-z])|^\s*(千米|公里|厘米|毫米|米|千克|公斤|毫克|克|毫秒|秒|分钟|兆赫|千赫|赫兹|千瓦|瓦)/u;
const digits = "零一二三四五六七八九";
function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digit = (s) => s === "〇" ? 0 : s === "两" ? 2 : digits.indexOf(s);
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0);
  }
  return Number([...value].map(digit).join(""));
}

function normalizeNumbers(value) {
  const text = String(value).normalize("NFKC")
    .replace(/第([零〇一二三四五六七八九十两]+)([章节篇部])/g, (_, n, kind) => `第${chineseNumber(n)}${kind}`)
    .replace(/\b(\d{3}0)['’]?s\b/g, "$1年代")
    // Hyphens between digits are range separators, not negative signs.
    .replace(/(?<=\d)\s*[-–—]\s*(?=\d)/g, " 至 ");
  return text.split(/(\n\s*\n)/).map((paragraph) => {
    let century = null;
    return paragraph.replace(/(?:([0-9零〇一二三四五六七八九十两]+)世纪\s*)?([0-9零〇一二三四五六七八九十两]+)年代/g, (_, c, d) => {
      if (c) century = (chineseNumber(c) - 1) * 100;
      let decade = chineseNumber(d);
      if (decade >= 1000) century = Math.floor(decade / 100) * 100;
      else if (century !== null) decade += century;
      return `${decade}年代`;
    });
  }).join("");
}

function numbers(value) {
  const text = normalizeNumbers(value);
  return [...text.matchAll(/[-+]?\d+(?:[.,]\d+)*/g)].map((match) => {
    const unit = text.slice(match.index + match[0].length).match(UNIT);
    return match[0] + (unit ? unitAliases.get(unit[1] || unit[2]) : "");
  });
}

export function missingNumericValues(source, target) {
  const targetValues = new Set(numbers(target));
  return [...new Set(numbers(source).filter((value) => !targetValues.has(value)))];
}

// Re-evaluate legacy mechanical findings, preserving IDs for review decisions.
// Semantic findings remain available as notes, including genuine wrong numbers.
export function applyNumericPolicy(issues, blocks = [], translations = []) {
  const sources = new Map(blocks.map((b) => [b.block_id, b.source]));
  const targets = new Map(translations.map((t) => [t.block_id, t.translation]));
  return issues.flatMap((raw) => {
    if (String(raw.category).toLowerCase() !== "numeric") return [raw];
    const item = { ...raw, severity: "note" };
    if (/^译文未发现这些原文数字或单位：/.test(item.description)
      && sources.has(item.block_id) && targets.has(item.block_id)) {
      const withoutNotes = (text) => text.replace(/\[\^?\d{1,3}\](?!:)/g, "");
      const missing = missingNumericValues(withoutNotes(sources.get(item.block_id)), withoutNotes(targets.get(item.block_id)));
      if (!missing.length) return [];
      item.description = `数值形式待核（最低级提示）：${missing.join(", ")}。字面差异不等于错译。`;
    }
    item.recommendation = "仅在语境中核对实际数值；标题词不是单位，等价年代表述无需修改。此提示不阻断交付。";
    return [item];
  });
}
