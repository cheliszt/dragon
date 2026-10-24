import path from "node:path";
import { readJson, writeJson, sha256, sleep } from "./utils.mjs";
import { transientError, retryDelay } from "./reliability.mjs";
import { SOURCE_CLEANUP_VERSION } from "./source-cleanup.mjs";
import { analyzeLanguages } from "./languages.mjs";

const SPLIT_ERRORS = new Set(["REQUEST_TIMEOUT", "STREAM_IDLE_TIMEOUT", "INCOMPLETE_RESPONSE", "INVALID_RESPONSE", "STREAM_INTERRUPTED", "STREAM_FAILED", "BLOCK_MISMATCH", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
const splittable = (error) => error.status === 524 || error.status === 504 || SPLIT_ERRORS.has(error.code) || error instanceof SyntaxError;

export function validateReview(blocks, value) {
  const ids = new Set(blocks.map((b) => b.block_id));
  if (!Array.isArray(value?.issues) || value.issues.some((q) => !["blocking", "warning", "note"].includes(q.severity)
    || typeof q.description !== "string" || typeof q.block_id !== "string"
    || !q.block_id.split(/[\s,;/]+/).every((id) => ids.has(id)))) {
    throw Object.assign(new Error("质检响应格式或对应单元无效。"), { code: "BLOCK_MISMATCH" });
  }
}

export function validateTranslations(blocks, translations) {
  if (!Array.isArray(translations) || blocks.length !== translations.length || blocks.some((b, i) =>
    translations[i]?.block_id !== b.block_id || typeof translations[i]?.translation !== "string" || !translations[i].translation.trim())) {
    throw Object.assign(new Error("模型返回的块序列不匹配或含空译文。"), { code: "BLOCK_MISMATCH" });
  }
}

function requestKey({ client, blocks, context, review = false, translations }) {
  return sha256(JSON.stringify({ blocks, context, review, translations, model: client.model, baseUrl: client.baseUrl,
    sourceCleanupVersion: SOURCE_CLEANUP_VERSION }));
}

// Inspect the exact request identity without making API calls. Split children may
// have succeeded even when their parent never produced a translated chunk file.
export async function cachedTranslationUnits(options) {
  const { blocks, cacheDir } = options;
  const key = requestKey(options);
  let saved;
  try { saved = await readJson(path.join(cacheDir, `text-${key}.json`)); }
  catch (e) { if (e.code === "ENOENT" || e instanceof SyntaxError) return []; throw e; }
  if (saved?.key !== key) return [];
  if (saved.value) {
    try { validateTranslations(blocks, saved.value.translations); return saved.value.translations; }
    catch { return []; }
  }
  if (!Number.isInteger(saved.split) || saved.split < 1 || saved.split >= blocks.length) return [];
  const results = [];
  for (const subset of [blocks.slice(0, saved.split), blocks.slice(saved.split)]) results.push(...await cachedTranslationUnits({ ...options, blocks: subset }));
  return results;
}

// Each successful subrequest is durable, including when a larger batch must be split.
export async function runTranslationJob({ client, blocks, context, cacheDir, review = false, translations, onSplit = () => {},
  onEvent = () => {}, checkpoint = () => {}, maxAttempts = 4, sleepImpl = sleep }) {
  if (!review && context.languagePolicy && blocks.some((b) => !b.languageSegments)) {
    const detected = await analyzeLanguages({ client, blocks, context, cacheDir, checkpoint, onEvent, maxAttempts, sleepImpl });
    blocks = blocks.map((b, i) => ({ ...b, languageSegments: detected.units[i].segments }));
  }
  const key = requestKey({ client, blocks, context, review, translations });
  const file = path.join(cacheDir, `${review ? "qa" : "text"}-${key}.json`);
  let cached;
  try { cached = await readJson(file); } catch {}
  if (cached?.key === key && cached.value) {
    try { if (!review) validateTranslations(blocks, cached.value.translations); else validateReview(blocks, cached.value); }
    catch { cached = null; }
    if (cached) {
      await onEvent({ state: "cached", phase: review ? "qa" : "translation" });
      return cached.value;
    }
  }
  try {
    if (cached?.key === key && cached.split) throw Object.assign(new Error("Resume split request"), { status: 524 });
    let response;
    for (let attempt = 1; ; attempt += 1) {
      await checkpoint();
      await onEvent({ state: "requesting", phase: review ? "qa" : "translation", attempt, maxAttempts, startedAt: new Date().toISOString(), receivedCharacters: 0 });
      try {
        response = review ? await client.review(blocks, translations, context) : await client.translate(blocks, context);
        if (review) validateReview(blocks, response.value); else validateTranslations(blocks, response.value?.translations);
        break;
      }
      catch (error) {
        if (blocks.length > 1 && splittable(error)) throw error;
        if (!(transientError(error) || splittable(error)) || attempt >= maxAttempts) throw error;
        const delay = retryDelay(error, attempt, { baseMs: error.code === "CONCURRENCY_LIMIT" || error.status === 429 ? 30000 : 2000 });
        await onEvent({ state: "retry_wait", phase: review ? "qa" : "translation", attempt, maxAttempts,
          code: error.code, status: error.status, message: error.message, nextRetryAt: new Date(Date.now() + delay).toISOString() });
        await sleepImpl(delay);
      }
    }
    if (!review) validateTranslations(blocks, response.value.translations);
    else validateReview(blocks, response.value);
    await writeJson(file, { key, ...response, savedAt: new Date().toISOString() });
    return response.value;
  } catch (error) {
    if (!splittable(error)) throw error;
    if (blocks.length <= 1) throw error;
    // Each block is a complete translation unit. Never subdivide its source text.
    const middle = Math.ceil(blocks.length / 2);
    await writeJson(file, { key, split: middle });
    await onSplit({ code: error.status || error.code, blocks: blocks.length });
    const values = [];
    for (const subset of [blocks.slice(0, middle), blocks.slice(middle)]) {
      const ids = new Set(subset.map((b) => b.block_id));
      values.push(await runTranslationJob({ client, blocks: subset, context, cacheDir, review,
        translations: translations?.filter((t) => ids.has(t.block_id)), onSplit, onEvent, checkpoint, maxAttempts, sleepImpl }));
    }
    const value = review ? { issues: values.flatMap((v) => v.issues) } : { translations: values.flatMap((v) => v.translations) };
    await writeJson(file, { key, value, savedAt: new Date().toISOString(), assembledFromSplit: true });
    return value;
  }
}

export async function mapWorkers(items, count, operation) {
  let next = 0;
  let failure;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
