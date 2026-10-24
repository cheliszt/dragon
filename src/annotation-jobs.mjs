import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildAnnotations } from "./annotations.mjs";
import { annotationDirectory } from "./annotation-store.mjs";
import { readJson, writeJson, sha256, sleep } from "./utils.mjs";
import { transientError, retryDelay } from "./reliability.mjs";
import { loadConfig, loadPromptFiles, requireSecret } from "./config.mjs";
import { OpenAIClient } from "./openai-client.mjs";
import { extractPdfText } from "./pdf-text.mjs";
import { splitMarkdownBlocks, chunkBlocks } from "./markdown.mjs";
import { reflowText } from "./reading-text.mjs";
import { runTranslationJob } from "./translation-jobs.mjs";
import { endsSentence } from "./translation-plan.mjs";
import { loadAuthorTerminology, terminologyContext } from "./author-terminology.mjs";
import { projectLanguages } from "./languages.mjs";

export function sourceParagraphs(unit, paragraphs) {
  const ends = new Set([unit.source.length]);
  for (const p of paragraphs) {
    if (!endsSentence(p)) continue;
    const tail = p.slice(-90).trim();
    if (tail.length < 5) continue;
    const at = unit.source.indexOf(tail);
    if (at >= 0 && unit.source.indexOf(tail, at + 1) < 0) ends.add(at + tail.length);
  }
  let start = 0;
  return [...ends].sort((a, b) => a - b).map((end, i) => {
    const result = { id: `p${i + 1}`, sourceStart: start, sourceEnd: end, source: unit.source.slice(start, end) };
    start = end; return result;
  }).filter((p) => p.source.trim());
}

export function validateAlignment(unit, references, paragraphs, value) {
  const locate = (items, expected) => {
    if (!Array.isArray(items) || items.length !== expected.length || new Set(items.map((i) => i.id)).size !== items.length) throw new Error("注释定位返回了不完整的标识。");
    return expected.map((e) => {
      const item = items.find((i) => i.id === e.id);
      if (typeof item?.quote !== "string" || !item.quote.trim()) throw new Error("注释定位缺少原样引文。");
      const at = unit.target.indexOf(item.quote);
      if (at < 0 || unit.target.indexOf(item.quote, at + 1) >= 0) throw new Error("注释定位引文不存在或不唯一，未改动正文。");
      return { ...e, targetQuote: item.quote, targetOffset: at + item.quote.length };
    });
  };
  const reuse = references.map((r) => ({ ...r, quote: existingTargetReference(unit, r) }));
  const choices = value?.references?.map((r) => ({ ...r, quote: reuse.find((x) => x.id === r.id)?.quote || r.quote }));
  const refs = locate(choices, references), parts = locate(value?.paragraphs, paragraphs);
  // Closing punctuation and existing callouts belong to the preceding paragraph.
  for (const p of parts) {
    const start = p.targetOffset - p.targetQuote.length;
    p.targetOffset += unit.target.slice(p.targetOffset).match(/^["”’')）\]]+/)?.[0].length || 0;
    for (const r of refs.filter((r) => r.sourceEnd === p.sourceEnd)) {
      if (r.targetOffset > p.targetOffset && /^[\s"”’')）。.!?！？]*$/.test(unit.target.slice(p.targetOffset, r.targetOffset))) p.targetOffset = r.targetOffset;
      const suffix = unit.target.slice(r.targetOffset);
      const marker = suffix.startsWith(`[^${r.label}]`) ? `[^${r.label}]` : suffix.startsWith(`[${r.label}]`) ? `[${r.label}]` : suffix.startsWith(r.label) && !/\d/.test(suffix[r.label.length] || "") ? r.label : "";
      if (marker && p.targetOffset >= r.targetOffset && p.targetOffset < r.targetOffset + marker.length) p.targetOffset = r.targetOffset + marker.length;
    }
    p.targetQuote = unit.target.slice(start, p.targetOffset);
  }
  if (parts.some((p, i) => i > 0 && p.targetOffset <= parts[i - 1].targetOffset)
    || /\S/.test(unit.target.slice(parts.at(-1)?.targetOffset || 0))) throw new Error("自然段定位顺序或末尾覆盖不完整。");
  for (const r of refs) {
    const index = parts.findIndex((p) => r.sourceStart >= p.sourceStart && r.sourceStart < p.sourceEnd);
    if (index < 0 || r.targetOffset > parts[index].targetOffset || index > 0 && r.targetOffset <= parts[index - 1].targetOffset) throw new Error(`注号 ${r.label || r.id} 超出对应自然段 ${parts[index]?.id || "未知"}，未改动正文。`);
  }
  return { references: refs, paragraphs: parts };
}

export function existingTargetReference(unit, ref) {
  if (typeof ref.label !== "string") return null;
  const label = ref.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`([。！？.!?][\"”’')）\\]]*)(\\[\\^?${label}\\]|${label})(?!\\d)`, "gu");
  const matches = [...unit.target.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const offset = matches[0].index + matches[0][1].length;
  const quote = unit.target.slice(Math.max(0, offset - 70), offset);
  return unit.target.indexOf(quote) === unit.target.lastIndexOf(quote) ? quote : null;
}

export async function prepareAnnotations(dir, model, { root, checkpoint = () => {}, sleepImpl, client, onProgress = () => {} } = {}) {
  const manifest = await readJson(path.join(dir, "manifest.json"));
  const folder = annotationDirectory(dir, model.version);
  let catalog;
  try { catalog = await readJson(path.join(folder, "catalog.json")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!catalog) {
    let footnotes = [];
    if (manifest.source.originalFile?.toLowerCase().endsWith(".pdf")) footnotes = (await extractPdfText(path.join(dir, manifest.source.originalFile))).footnotes;
    const approved = manifest.source.approvedFile ? await readFile(path.join(dir, manifest.source.approvedFile), "utf8")
      : model.units.map((u) => u.source).join("\n\n");
    catalog = buildAnnotations(approved, model, { footnotes });
  }
  await writeJson(path.join(folder, "catalog.json"), catalog);
  // Seed model-produced translator notes once. Human edits/deletions remain authoritative.
  try { await readJson(path.join(folder, "current.json")); }
  catch (e) {
    if (e.code !== "ENOENT") throw e;
    const translatorNotes = model.units.flatMap((u) => u.translatorNotes || []);
    if (translatorNotes.length) await writeJson(path.join(folder, "current.json"), { revision: 0, notes: {}, translatorNotes, history: [] });
  }
  if (!catalog.notes.length) return catalog;
  let paragraphs;
  try { paragraphs = await readJson(path.join(folder, "source-paragraphs-v2.json")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!paragraphs) {
    let text;
    if (manifest.source.originalFile?.toLowerCase().endsWith(".pdf")) text = (await extractPdfText(path.join(dir, manifest.source.originalFile))).markdown;
    else text = model.units.map((u) => u.source).join("\n\n");
    paragraphs = splitMarkdownBlocks(text).map((s) => reflowText(s, "en")).filter(Boolean);
    await writeJson(path.join(folder, "source-paragraphs-v2.json"), paragraphs);
  }
  const config = await loadConfig(root);
  const prompts = await loadPromptFiles(path.join(dir, "00_shared"));
  client ||= new OpenAIClient({ ...config.openai, apiKey: requireSecret("OPENAI_API_KEY") });
  const context = { workflow: prompts["workflow.md"], styleGuide: prompts["style-guide.md"], glossary: prompts["glossary.md"], ...(manifest.languages ? projectLanguages(manifest, config) : { targetLanguage: config.translation.targetLanguage }),
    authorTerminology: terminologyContext(await loadAuthorTerminology(dir)) };
  const missing = catalog.notes.filter((n) => !n.translation).map((n) => ({ block_id: n.id, source: n.source }));
  for (const batch of chunkBlocks(missing, config.openai.chunkMaxChars)) {
    await checkpoint();
    await onProgress({ phase: "note-translation", remaining: catalog.notes.filter((n) => !n.translation).length });
    const result = await runTranslationJob({ client, blocks: batch, context, cacheDir: path.join(folder, "requests"), checkpoint, sleepImpl });
    for (const t of result.translations) Object.assign(catalog.notes.find((n) => n.id === t.block_id), { translation: t.translation, translationOrigin: "translated-note" });
    await writeJson(path.join(folder, "catalog.json"), catalog);
  }
  const needed = model.units.filter((u) => catalog.references.some((r) => r.unitId === u.id));
  let done = 0;
  for (const unit of needed) {
    await checkpoint();
    const refs = catalog.references.filter((r) => r.unitId === unit.id);
    const parts = sourceParagraphs(unit, paragraphs);
    const input = { source: unit.source, target: unit.target,
      references: refs.map((r) => ({ id: r.id, sourceQuote: r.sourceQuote, label: r.label })), paragraphs: parts.map(({ id, source }) => ({ id, source })) };
    const file = path.join(folder, "requests", `alignment-${sha256(JSON.stringify(input))}.json`);
    let value;
    try { value = await readJson(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
    await onProgress({ phase: "note-alignment", completed: done, total: needed.length, unitId: unit.id });
    if (!value) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        for (let requestAttempt = 1; ; requestAttempt++) {
          try { response = await client.alignAnnotations(input); break; }
          catch (e) {
            if (!transientError(e) || requestAttempt >= 4) throw e;
            const delay = retryDelay(e, requestAttempt, { baseMs: e.code === "CONCURRENCY_LIMIT" ? 30000 : 2000 });
            await onProgress({ phase: "retry-wait", unitId: unit.id, attempt: requestAttempt, delay });
            await (sleepImpl || sleep)(delay); await checkpoint();
          }
        }
        try { validateAlignment(unit, refs, parts, response.value); value = response.value; break; }
        catch (e) { await writeJson(`${file}.invalid-${attempt}.json`, { error: e.message, value: response.value }); if (attempt === 2) throw e; input.alignmentFeedback = e.message; }
      }
      await writeJson(file, value);
    }
    const aligned = validateAlignment(unit, refs, parts, value);
    for (const r of aligned.references) Object.assign(catalog.references.find((x) => x.id === r.id), { targetQuote: r.targetQuote, placement: "verified" });
    catalog.paragraphMaps[unit.id] = { targetHash: sha256(unit.target), paragraphs: aligned.paragraphs.map(({ source, ...p }) => p) };
    done++;
    await writeJson(path.join(folder, "catalog.json"), catalog);
  }
  catalog.completedAt = new Date().toISOString();
  await writeJson(path.join(folder, "catalog.json"), catalog);
  await onProgress({ phase: "completed", completed: done, total: needed.length });
  return catalog;
}
