import { copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { findSourceIssues } from "../web/source-issues.js";
import { randomUUID } from "node:crypto";
import { APP_ROOT, loadConfig, loadPromptFiles, requireSecret } from "./config.mjs";
import { applyNumericPolicy } from "./numeric-qa.mjs";
import { prepareTranslationInput } from "./normalized-source.mjs";
import { translationReuse } from "./translation-reuse.mjs";
import { projectLanguages, analyzeLanguages } from "./languages.mjs";
import { PaddleCloudClient, parsePaddleOcrJsonl } from "./paddle-client.mjs";
import { OpenAIClient } from "./openai-client.mjs";
import { extractPdfText } from "./pdf-text.mjs";
import { cleanSourceMarkdown } from "./source-cleanup.mjs";
import { prepareAnnotations } from "./annotation-jobs.mjs";
import { publishAnnotationExports } from "./annotation-exports.mjs";
import { readAnnotations } from "./annotation-store.mjs";
import { prepareAuthorTerminology, terminologyContext } from "./author-terminology.mjs";
import { prepareTermBaseline, termContext, terminologyIssues } from "./term-baseline.mjs";
import { reviewCurrentDraft } from './review-qa-jobs.mjs';
import { reviewSnapshot } from './review-edits.mjs';
import { runTranslationJob, cachedTranslationUnits } from "./translation-jobs.mjs";
import { writeTranslationDraft } from "./translation-draft.mjs";
import { transientError } from "./reliability.mjs";
import { withTranslationLock } from "./translation-lock.mjs";
import { writeReadingOutputs } from "./reading-outputs.mjs";
import { validateSentenceBoundaries } from "./translation-plan.mjs";
import {
  chunkBlocks,
  parseStructuredMarkdown,
  structureMarkdown
} from "./markdown.mjs";
import { deterministicQa, qaMarkdown } from "./qa.mjs";
import {
  ensureDir,
  errorMessage,
  normalizeText,
  readJson,
  safeName,
  sha256,
  sha256File,
  timestampId,
  writeJson,
  writeText
} from "./utils.mjs";

export async function runOcr(filePath, options = {}) {
  return prepareSource(filePath, { ...options, mode: "ocr" });
}

export async function prepareSource(filePath, options = {}) {
  const config = await loadConfig(options.root || APP_ROOT);
  const mode = options.mode || "auto";
  if (!["auto", "text", "ocr"].includes(mode)) throw new Error("处理方式必须是 auto、text 或 ocr。");
  const remoteInput = isHttpUrl(filePath);
  const absoluteInput = remoteInput ? filePath : path.resolve(filePath);
  const localPdf = !remoteInput && path.extname(absoluteInput).toLowerCase() === ".pdf";
  if (mode === "text" && !localPdf) throw new Error("直接提取文字仅支持本地 PDF。");
  const sourceBaseName = remoteInput ? remoteSourceName(filePath) : path.basename(absoluteInput);
  const projectId = options.projectId || `${timestampId()}-${safeName(path.parse(sourceBaseName).name)}-${randomUUID().slice(0, 8)}`;
  const projectDir = path.join(options.projectsDir || path.join(APP_ROOT, "projects"), projectId);
  await createProjectDirs(projectDir);

  const originalTarget = remoteInput ? undefined : path.join(projectDir, "01_source_original", sourceBaseName);
  if (!remoteInput) await copyFile(absoluteInput, originalTarget);
  const manifest = {
    projectId,
    languages: options.languages ? projectLanguages({ languages: options.languages }, config) : projectLanguages({}, config),
    createdAt: new Date().toISOString(),
    status: mode !== "ocr" && localPdf ? "source_inspecting" : "ocr_submitting",
    preparation: { requestedMode: mode, method: null, pageRanges: options.pageRanges },
    source: remoteInput
      ? { fileUrl: filePath }
      : {
          originalFile: path.relative(projectDir, originalTarget),
          sha256: await sha256File(originalTarget)
        },
    paddle: {
      model: options.model || config.paddle.model,
      apiBaseUrl: config.paddle.baseUrl
    }
  };
  await saveManifest(projectDir, manifest);

  await options.onProjectCreated?.(projectDir);

  return resumePreparation(projectDir, options);
}

export async function resumePreparation(projectDir, options = {}) {
  const config = await loadConfig(options.root || APP_ROOT);
  const manifest = await loadManifest(projectDir);
  if (manifest.source.candidateFile) return { projectDir, manifest };
  const mode = manifest.preparation.requestedMode;
  const remoteInput = Boolean(manifest.source.fileUrl);
  const filePath = manifest.source.fileUrl;
  const originalTarget = remoteInput ? null : path.join(projectDir, manifest.source.originalFile);
  const localPdf = originalTarget && path.extname(originalTarget).toLowerCase() === ".pdf";
  const projectId = manifest.projectId;
  options.pageRanges ??= manifest.preparation.pageRanges;

  try {
    await options.checkpoint?.();
    if (!manifest.paddle.jobId && !manifest.paddle.submissionStartedAt && mode !== "ocr" && localPdf) {
      const extracted = await extractPdfText(originalTarget, {
        pageRanges: options.pageRanges, thresholds: config.textLayer,
        onProgress: async (progress) => { manifest.preparation.progress = progress; await saveManifest(projectDir, manifest); }
      });
      await writeJson(path.join(projectDir, "04_qa", "text-layer.json"), extracted.report);
      manifest.preparation.textLayer = extracted.report;
      if (mode === "text" || extracted.report.suitable) {
        if (!extracted.report.totalCharacters) throw new Error("PDF 没有可提取文字，请改用云端 OCR。");
        manifest.preparation.method = "text";
        const rawText = path.join(projectDir, "02_source_candidates", "raw_text", "document.md");
        await writeText(rawText, extracted.rawMarkdown);
        await writeCandidate(projectDir, manifest, extracted.markdown, extracted.cleanup);
        return { projectDir, manifest };
      }
    }
    manifest.preparation.method = "ocr";
    manifest.status = manifest.paddle.jobId ? "ocr_running" : "ocr_submitting";
    await saveManifest(projectDir, manifest);
    const client = options.paddleClient || new PaddleCloudClient({
      token: requireSecret("PADDLEOCR_ACCESS_TOKEN"),
      baseUrl: config.paddle.baseUrl,
      pollIntervalMs: config.paddle.pollIntervalMs,
      timeoutMs: config.paddle.timeoutMs, sleepImpl: options.sleepImpl, checkpoint: options.checkpoint,
      onRetry: async (event) => { manifest.preparation.retry = { ...event, nextRetryAt: new Date(Date.now() + event.delayMs).toISOString() }; await saveManifest(projectDir, manifest); }
    });

    const submitOptions = {
      model: manifest.paddle.model,
      optionalPayload: config.paddle.optionalPayload,
      pageRanges: options.pageRanges,
      batchId: projectId
    };
    if (!manifest.paddle.jobId) {
    if (manifest.paddle.submissionStartedAt) throw Object.assign(new Error("OCR 提交结果不确定，未自动重复上传。请在 AI Studio 确认任务后再处理，避免重复扣费。"), { code: "SUBMISSION_UNKNOWN" });
    manifest.paddle.submissionStartedAt = new Date().toISOString();
    await saveManifest(projectDir, manifest);
    const submitted = remoteInput
      ? await client.submitUrl(filePath, submitOptions)
      : await client.submitFile(originalTarget, submitOptions);
    manifest.paddle.jobId = submitted.data.jobId;
    manifest.status = "ocr_running";
    await writeJson(path.join(projectDir, "04_qa", "ocr-submit.json"), submitted);
    await saveManifest(projectDir, manifest);
    }

    const completed = await client.waitForJob(manifest.paddle.jobId, async (response) => {
      manifest.paddle.lastState = response.data?.state;
      manifest.paddle.progress = response.data?.extractProgress;
      delete manifest.preparation.retry;
      delete manifest.error;
      await saveManifest(projectDir, manifest);
    });
    await writeJson(path.join(projectDir, "04_qa", "ocr-result.json"), completed);

    const urls = completed.data?.resultUrl || {};
    if (!urls.jsonUrl && !urls.markdownUrl) {
      throw new Error("OCR 任务完成，但响应中没有 jsonUrl 或 markdownUrl。");
    }
    const rawDir = path.join(projectDir, "02_source_candidates", "raw_ocr");
    const rawMarkdown = path.join(rawDir, "document.md");
    if (urls.jsonUrl) {
      const rawJsonl = path.join(rawDir, "document.jsonl");
      await client.download(urls.jsonUrl, rawJsonl);
      const extracted = parsePaddleOcrJsonl(await readFile(rawJsonl, "utf8"));
      await writeText(rawMarkdown, extracted.markdown);
      await downloadOcrAssets(client, rawDir, extracted);
      manifest.paddle.downloadedAssets = {
        markdownImages: extracted.markdownImages.length,
        outputImages: extracted.outputImages.length
      };
    } else {
      await client.download(urls.markdownUrl, rawMarkdown);
    }

    manifest.paddle.resultUrlsDownloadedAt = new Date().toISOString();
    await writeCandidate(projectDir, manifest, await readFile(rawMarkdown, "utf8"));
    return { projectDir, manifest };
  } catch (error) {
    manifest.status = error.code === "PAUSED" ? "source_paused" : manifest.preparation.method === "ocr" ? "ocr_failed" : "source_failed";
    manifest.error = errorMessage(error);
    if (error.diagnostics) await writeJson(path.join(projectDir, "04_qa", "ocr-error.json"), error.diagnostics);
    await saveManifest(projectDir, manifest);
    throw error;
  }
}

async function writeCandidate(projectDir, manifest, markdown, extractionAudit) {
  const cleaned = cleanSourceMarkdown(markdown);
  const audit = { ...cleaned.audit, stage: "extraction", removals: [...(extractionAudit?.removals || []), ...cleaned.audit.removals],
    normalizations: [...(extractionAudit?.normalizations || []), ...cleaned.audit.normalizations] };
  const auditFile = "04_qa/source-cleanup-extraction.json";
  await writeJson(path.join(projectDir, auditFile), audit);
  manifest.source.cleanup = { version: audit.version, removed: audit.removals.length, structuredNotes: audit.normalizations.length, auditFile };
  const normalized = structureMarkdown(cleaned.markdown);
  const reconciled = path.join(projectDir, "02_source_candidates", "reconciled", "document.md");
  await writeText(reconciled, normalized);
  manifest.status = "source_review_required";
  manifest.source.candidateFile = path.relative(projectDir, reconciled);
  manifest.source.candidateSha256 = sha256(normalized);
  const terminology = await prepareAuthorTerminology(projectDir, parseStructuredMarkdown(normalized));
  manifest.source.terminology = { detected: terminology.detected, entries: terminology.entries.length,
    file: "00_shared/author-terminology.json" };
  await saveManifest(projectDir, manifest);
}

export async function approveSource(projectDir, { allowUnresolved = false } = {}) {
  projectDir = path.resolve(projectDir);
  const manifest = await loadManifest(projectDir);
  const candidatePath = path.join(projectDir, manifest.source.candidateFile);
  const source = normalizeText(await readFile(candidatePath, "utf8"));
  const unresolved = findSourceIssues(source);
  if (unresolved.length && !allowUnresolved) {
    throw new Error(`源文仍包含 ${unresolved.length} 个未决标记；请在网页「原文校对」的待核对清单中定位并逐项确认，保存后再批准。命令行可明确使用 --allow-unresolved。`);
  }

  const approvedRoot = path.join(projectDir, "03_source_approved");
  let existing = [];
  try { existing = await readdir(approvedRoot); } catch {}
  const revision = `r${String(existing.filter((name) => /^r\d{3}$/.test(name)).length + 1).padStart(3, "0")}`;
  const approvedPath = path.join(approvedRoot, revision, "document.md");
  await writeText(approvedPath, source);
  manifest.source.approvedFile = path.relative(projectDir, approvedPath);
  manifest.source.revision = revision;
  manifest.source.approvedSha256 = sha256(source);
  manifest.source.approvedAt = new Date().toISOString();
  const config = await loadConfig();
  await prepareTranslationInput(projectDir, manifest, parseStructuredMarkdown(source), config.openai.unitMaxChars || config.openai.chunkMaxChars);
  manifest.status = "source_approved";
  delete manifest.error;
  await saveManifest(projectDir, manifest);
  return manifest;
}

export async function translateProject(projectDir, options = {}) {
  if (options.lockHeld) return translateProjectLocked(projectDir, options);
  return withTranslationLock(projectDir, () => translateProjectLocked(projectDir, options), { root: options.root || APP_ROOT });
}

async function translateProjectLocked(projectDir, { root = APP_ROOT, checkpoint = () => {}, sleepImpl, languages } = {}) {
  projectDir = path.resolve(projectDir);
  const config = await loadConfig(root);
  const manifest = await loadManifest(projectDir);
  if (languages) {
    const next = projectLanguages({ languages }, config);
    if (manifest.openai && JSON.stringify(next) !== JSON.stringify(projectLanguages(manifest, config))) throw new Error("翻译已开始，不能更改该任务的语言设置；请新建项目。");
    manifest.languages = next;
  }
  if (manifest.status !== "source_approved" && !["translation_failed", "translation_paused", "qa_failed", "translating"].includes(manifest.status)) {
    throw new Error(`当前状态为 ${manifest.status}；只有批准源文后才能翻译。`);
  }
  const approvedPath = path.join(projectDir, manifest.source.approvedFile);
  const approved = normalizeText(await readFile(approvedPath, "utf8"));
  const currentHash = sha256(approved);
  if (currentHash !== manifest.source.approvedSha256) {
    throw new Error("批准源文哈希已变化。请重新执行 approve，旧译文不能继续沿用。 ");
  }

  if (manifest.reading?.version && manifest.draft?.qaComplete) {
    const snapshot = await reviewSnapshot(projectDir);
    if (snapshot.model.sourceHash !== currentHash) throw new Error('当前译稿与批准原文不匹配，拒绝覆盖。');
    try {
      const reviewed = await reviewCurrentDraft(projectDir, { root, mode: 'all', checkpoint, sleepImpl,
        onProgress: async (progress) => { manifest.openai.request = progress; await saveManifest(projectDir, manifest); } });
      const activeIds = new Set(reviewed.model.units.flatMap(u => u.issueIds));
      const issues = reviewed.model.issues.filter(q => activeIds.has(q.id));
      const summary = Object.fromEntries(['blocking','warning','note'].map(level => [level,issues.filter(q=>q.severity===level).length]));
      const report = { status: summary.blocking ? 'failed' : 'passed', summary, issues };
      manifest.status = summary.blocking ? 'qa_failed' : 'completed';
      manifest.openai.request = { state: 'completed' }; delete manifest.error;
      await saveManifest(projectDir, manifest);
      return { manifest, report };
    } catch (error) {
      manifest.error = errorMessage(error);
      await saveManifest(projectDir, manifest);
      throw error;
    }
  }

  const sourceBlocks = parseStructuredMarkdown(approved);
  if (!sourceBlocks.length) throw new Error("批准源文中没有可识别的 block_id。 ");
  const plan = await prepareTranslationInput(projectDir, manifest, sourceBlocks, manifest.openai?.translationPlan?.maxChars || config.openai.unitMaxChars || config.openai.chunkMaxChars);
  await saveManifest(projectDir, manifest);
  if (!validateSentenceBoundaries(plan)) throw new Error("原文存在无法接续的残句，已记录到连续原文的 boundary-audit.json；不会将残句单独提交翻译。");
  let blocks = plan.units;
  let chunks = chunkBlocks(blocks, config.openai.chunkMaxChars);
  const prompts = await loadPromptFiles(path.join(projectDir, "00_shared"));
  const context = {
    workflow: prompts["workflow.md"],
    styleGuide: prompts["style-guide.md"],
    glossary: prompts["glossary.md"],
    ...projectLanguages(manifest, config),
    translationPlanVersion: plan.version,
    authorTerminology: terminologyContext(await prepareAuthorTerminology(projectDir, sourceBlocks), blocks)
  };
  const client = new OpenAIClient({
    apiKey: requireSecret("OPENAI_API_KEY"),
    model: config.openai.model,
    baseUrl: config.openai.baseUrl,
    maxOutputTokens: config.openai.maxOutputTokens,
    stream: config.openai.stream,
    timeoutMs: config.openai.timeoutMs,
    idleTimeoutMs: config.openai.idleTimeoutMs
  });
  const baseline = await prepareTermBaseline(projectDir, blocks, { client, sourceHash: currentHash,
    targetLanguage: context.targetLanguage, glossary: context.glossary, checkpoint, sleepImpl, maxAttempts: config.openai.requestAttempts || 4,
    onProgress: async (progress) => { manifest.terminologyProgress = progress; await saveManifest(projectDir, manifest); } });
  context.termBaseline = termContext(baseline);
  manifest.terminologyProgress = { phase: "ready", entries: baseline.entries.length, revision: baseline.revision };
  const reuse = await translationReuse(projectDir, manifest, plan, chunks, context, config.openai);
  // New requests use current rules. Keep earlier contexts only to recover
  // successful split requests without translating their text again.
  const contextFile = path.join(projectDir, '05_bilingual/runs', plan.version, sha256(JSON.stringify(projectLanguages(manifest, config))), 'translation-context.json');
  const translationContext = context;
  let cachedContexts = [context];
  try {
    const stored = await readJson(contextFile);
    if (stored.sourceHash === currentHash && stored.model === config.openai.model && stored.baseUrl === config.openai.baseUrl) {
      cachedContexts.push(stored.context, ...(stored.previousContexts || []));
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  cachedContexts = [...new Map(cachedContexts.filter(Boolean).map((c) => [JSON.stringify(c), c])).values()];
  await writeJson(contextFile, { sourceHash: currentHash, model: config.openai.model, baseUrl: config.openai.baseUrl,
    context: translationContext, previousContexts: cachedContexts.slice(1) });
  manifest.languages = projectLanguages(manifest, config);
  const previousRun = manifest.openai;
  const chunkDirectory = `05_bilingual/runs/${plan.version}/${sha256(JSON.stringify(manifest.languages))}/chunks`;
  const sameRun = previousRun?.chunkDirectory === chunkDirectory && previousRun.model === config.openai.model
    && previousRun.baseUrl === config.openai.baseUrl;

  manifest.status = "translating";
  delete manifest.error;
  manifest.openai = {
    model: config.openai.model,
    baseUrl: config.openai.baseUrl,
    targetLanguage: context.targetLanguage,
    sourceLanguages: context.sourceLanguages, languagePolicy: context.languagePolicy,
    chunkCount: chunks.length, completedChunks: sameRun ? previousRun.completedChunks || 0 : 0, startedAt: new Date().toISOString(), stream: config.openai.stream,
    translationPlan: { version: plan.version, maxChars: plan.maxChars, schemaVersion: plan.schemaVersion },
    chunkDirectory
  };
  manifest.openai.reusedUnits = Object.keys(reuse.translations).length;
  manifest.openai.reusedFromPlan = reuse.fromPlanVersion;
  manifest.openai.translatedChunks = sameRun ? previousRun.translatedChunks || 0 : 0;
  manifest.openai.reviewedChunks = sameRun ? previousRun.reviewedChunks || 0 : 0;
  manifest.openai.adoptedUnits = reuse.adoptedCheckpoint ? reuse.adoptedUnitCount ?? Object.keys(reuse.translations).length : 0;
  manifest.openai.translatedChunks = Math.max(manifest.openai.translatedChunks,
    chunks.filter((chunk) => chunk.every((b) => reuse.translations[b.block_id])).length);
  delete manifest.errorDetails;
  manifest.sharedInputs = {
    workflowSha256: sha256(context.workflow),
    styleGuideSha256: sha256(context.styleGuide),
    glossarySha256: sha256(context.glossary),
    authorTerminologySha256: sha256(JSON.stringify(context.authorTerminology))
  };
  await saveManifest(projectDir, manifest);
  const chunkDir = path.join(projectDir, manifest.openai.chunkDirectory);
  await ensureDir(chunkDir);
  await writeJson(path.join(chunkDir, "..", "translation-plan.json"), plan);

  const savedTranslations = new Map();
  for (const t of Object.values(reuse.translations)) savedTranslations.set(t.block_id, t);
  const publishDraft = async () => writeTranslationDraft(projectDir, blocks, blocks.flatMap((b) => savedTranslations.has(b.block_id) ? [savedTranslations.get(b.block_id)] : []), manifest);
  try {
    let saveQueue = Promise.resolve();
    const persist = () => { saveQueue = saveQueue.then(() => saveManifest(projectDir, manifest)); return saveQueue; };
    let lastProgressAt = 0;
    client.onProgress = async (progress) => {
      if (Date.now() - lastProgressAt < 1000) return;
      lastProgressAt = Date.now();
      manifest.openai.request = { ...manifest.openai.request, ...progress, state: "receiving", lastReceivedAt: new Date().toISOString() };
      await persist();
    };
    const analyzed = [];
    for (const [index, chunk] of chunks.entries()) {
      const pending = chunk.filter((b) => !reuse.translations[b.block_id]);
      if (!pending.length) { analyzed.push(...chunk); continue; }
      const detection = await analyzeLanguages({ client, blocks: pending, context, cacheDir: path.join(chunkDir, "requests"), checkpoint, sleepImpl,
        maxAttempts: config.openai.requestAttempts || 4,
        onEvent: async (event) => { manifest.openai.request = { ...event, chunk: index + 1 }; await persist(); } });
      const segments = new Map(detection.units.map((u) => [u.block_id,u.segments]));
      analyzed.push(...chunk.map((b) => segments.has(b.block_id) ? { ...b, languageSegments: segments.get(b.block_id) } : b));
      manifest.openai.detectedChunks = index + 1;
    }
    blocks = analyzed;
    chunks = chunkBlocks(blocks, config.openai.chunkMaxChars);
    await writeJson(path.join(chunkDir, "..", "language-analysis.json"), { settings: manifest.languages, units: blocks.map((b) => ({ block_id: b.block_id, segments: b.languageSegments })) });
    const requestOptions = (chunk, index) => ({ client, blocks: chunk, context: translationContext, cacheDir: path.join(chunkDir, "requests"),
      checkpoint, sleepImpl, maxAttempts: config.openai.requestAttempts || 4,
      onEvent: async (event) => { manifest.openai.request = { ...event, chunk: index + 1 }; await persist(); },
      onSplit: async (event) => { manifest.openai.lastSplit = { ...event, chunk: index + 1 }; await persist(); } });
    for (const [index, chunk] of chunks.entries()) {
      const pending = chunk.filter((b) => !reuse.translations[b.block_id]);
      if (pending.length) for (const cachedContext of cachedContexts) {
        const recovered = await cachedTranslationUnits({ ...requestOptions(pending, index), context: cachedContext });
        for (const t of recovered) if (!reuse.translations[t.block_id]) {
          reuse.translations[t.block_id] = t;
          savedTranslations.set(t.block_id, t);
        }
      }
      for (const b of chunk) if (reuse.translations[b.block_id]) savedTranslations.set(b.block_id, reuse.translations[b.block_id]);
    }
    manifest.openai.translatedChunks = chunks.filter((chunk) => chunk.every((b) => savedTranslations.has(b.block_id))).length;
    await publishDraft();
    await persist();
    const results = [];
    for (const [index, chunk] of chunks.entries()) {
      await checkpoint();
      const missing = chunk.filter((unit) => !reuse.translations[unit.block_id]);
      const fresh = missing.length ? await runTranslationJob(requestOptions(missing, index)) : { translations: [] };
      const byId = new Map(fresh.translations.map((t) => [t.block_id, t]));
      const result = { translations: chunk.map((u) => reuse.translations[u.block_id] || byId.get(u.block_id)) };
      validateChunk(chunk, result.translations);
      await writeJson(path.join(chunkDir, `${String(index + 1).padStart(4, "0")}-translated.json`), result);
      results.push({ translations: result.translations, issues: [] });
      for (const t of result.translations) savedTranslations.set(t.block_id, t);
      manifest.openai.translatedChunks = chunks.filter((c) => c.every((b) => savedTranslations.has(b.block_id))).length;
      await publishDraft();
      await persist();
    }
    for (const [index, chunk] of chunks.entries()) {
      await checkpoint();
      const qa = !config.openai.semanticQa ? { issues: [] } : reuse.reviewChunks.includes(index)
        ? await runTranslationJob({ ...requestOptions(chunk, index), context, review: true, translations: results[index].translations })
        : { issues: reuse.issues.filter((q) => chunk.some((u) => u.block_id === q.block_id.match(/U\d+/)?.[0])) };
      await writeJson(path.join(projectDir, "04_qa", `semantic-${String(index + 1).padStart(4, "0")}.json`), qa);
      manifest.openai.completedChunks = Math.max(manifest.openai.completedChunks, index + 1);
      manifest.openai.reviewedChunks = Math.max(manifest.openai.reviewedChunks, index + 1);
      await persist();
      console.log(`翻译与质检：${manifest.openai.completedChunks}/${chunks.length}`);
      results[index].issues = qa.issues;
    }
    const translations = results.flatMap((r) => r.translations);
    const semanticIssues = results.flatMap((r) => r.issues);

    await writeJson(path.join(projectDir, "04_qa", "translator-notes.json"), translations.map((item) => ({
      block_id: item.block_id,
      source_questions: item.source_questions || [],
      translator_notes: item.translator_notes || []
    })).filter((item) => item.source_questions.length || item.translator_notes.length));

    const issues = applyNumericPolicy([...deterministicQa(blocks, translations), ...semanticIssues,
      ...terminologyIssues(blocks, translations, baseline)], blocks, translations);
    const summary = {
      blocking: issues.filter((item) => item.severity === "blocking").length,
      warning: issues.filter((item) => item.severity === "warning").length,
      note: issues.filter((item) => item.severity === "note").length
    };
    const report = { status: summary.blocking ? "failed" : "passed", sourceRevision: manifest.source.revision, sourceSha256: currentHash, summary, issues };
    await writeJson(path.join(projectDir, "04_qa", "final.json"), report);
    await writeText(path.join(projectDir, "04_qa", "final.md"), qaMarkdown(report));

    manifest.status = summary.blocking ? "qa_failed" : "completed";
    manifest.completedAt = new Date().toISOString();
    manifest.openai.request = { state: "completed" };
    manifest.outputs = {
      bilingual: "05_bilingual/project_bilingual.md",
      chinese: "06_zh/project_zh.md",
      qa: "04_qa/final.md"
    };
    const model = await writeReadingOutputs(projectDir, blocks, translations, report, manifest);
    if (manifest.draft) manifest.draft.qaComplete = true;
    await prepareAnnotations(projectDir, model, { root, client, checkpoint, sleepImpl,
      onProgress: async (progress) => { manifest.annotationProgress = progress; await saveManifest(projectDir, manifest); } });
    const annotated = await readAnnotations(projectDir, model);
    if (annotated.model.annotations) await publishAnnotationExports(projectDir, annotated.model);
    await saveManifest(projectDir, manifest);
    return { manifest, report };
  } catch (error) {
    // Retain successful split children, including those from the failing batch.
    try {
      for (const chunk of chunks) {
        if (chunk.some((b) => !b.languageSegments)) continue;
        const pending = chunk.filter((b) => !reuse.translations[b.block_id]);
        if (pending.length) for (const t of await cachedTranslationUnits({ client, blocks: pending, context: translationContext, cacheDir: path.join(chunkDir, "requests") })) savedTranslations.set(t.block_id, t);
      }
      await publishDraft();
    } catch (draftError) { manifest.draftError = errorMessage(draftError); }
    manifest.status = error.code === "PAUSED" ? "translation_paused" : "translation_failed";
    manifest.error = errorMessage(error);
    manifest.errorDetails = { code: error.code, status: error.status, retryable: transientError(error),
      phase: manifest.openai.request?.phase, chunk: manifest.openai.request?.chunk };
    if (error.diagnostics) await writeJson(path.join(projectDir, "04_qa", "translation-error.json"), error.diagnostics);
    await saveManifest(projectDir, manifest);
    throw error;
  }
}

export async function runAll(filePath, { autoApprove = false, ...options } = {}) {
  const result = await prepareSource(filePath, options);
  if (!autoApprove) return result;
  await approveSource(result.projectDir);
  return { projectDir: result.projectDir, ...(await translateProject(result.projectDir)) };
}

function validateChunk(source, translations) {
  const expected = source.map((item) => item.block_id);
  const actual = translations.map((item) => item.block_id);
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error(`模型返回的块序列不匹配。期望 ${expected.join(", ")}；实际 ${actual.join(", ")}`);
  }
}

async function createProjectDirs(projectDir) {
  await Promise.all([
    "00_shared", "01_source_original", "02_source_candidates/raw_ocr",
    "02_source_candidates/reconciled", "03_source_approved", "04_qa",
    "05_bilingual/chunks", "06_zh"
  ].map((dir) => ensureDir(path.join(projectDir, dir))));
  for (const name of ["workflow.md", "style-guide.md", "glossary.md"]) {
    await copyFile(path.join(APP_ROOT, "config", name), path.join(projectDir, "00_shared", name));
  }
}

async function loadManifest(projectDir) {
  return readJson(path.join(projectDir, "manifest.json"));
}

async function saveManifest(projectDir, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(projectDir, "manifest.json"), manifest);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function remoteSourceName(fileUrl) {
  const url = new URL(fileUrl);
  const name = path.posix.basename(url.pathname);
  return name || "remote-document";
}

async function downloadOcrAssets(client, rawDir, extracted) {
  for (const image of extracted.markdownImages) {
    await client.download(image.url, safeTarget(rawDir, image.relativePath));
  }

  const outputDir = path.join(rawDir, "output_images");
  for (const image of extracted.outputImages) {
    const filename = `${safeName(image.name)}_${image.lineIndex}_${image.resultIndex}.jpg`;
    await client.download(image.url, path.join(outputDir, filename));
  }
}

function safeTarget(baseDir, relativePath) {
  const root = path.resolve(baseDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`OCR 图片路径越界：${relativePath}`);
  }
  return target;
}
