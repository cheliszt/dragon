import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createWebServer } from "../src/web-server.mjs";
import { loadConfig } from "../src/config.mjs";
import { taskState, pauseTask, recoverTask, startTask } from "../src/task-manager.mjs";
import { translationOwner } from "../src/translation-lock.mjs";
import { writeText, writeJson, readJson, sha256, sleep } from "../src/utils.mjs";
import { structureMarkdown } from "../src/markdown.mjs";
import { runTask } from "../src/task-worker.mjs";
import { analyzeLanguages, languageSettings } from "../src/languages.mjs";
import { buildTranslationPlan } from "../src/translation-plan.mjs";
import { chunkBlocks, parseStructuredMarkdown } from "../src/markdown.mjs";
import { applyReviewEdit, reviewSnapshot } from "../src/review-edits.mjs";

async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(30); }
  throw new Error('Timed out waiting for test worker state');
}

test("manual resume from paused language detection keeps selected languages, reuses cache and ignores the previous pause marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-resume-")), dir = path.join(root, "projects/book");
  const savedEnv = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((k) => [k, process.env[k]]));
  const calls = [];
  let web;
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw), name = body.text.format.name; calls.push(name);
    let value;
    if (name === "terminology_candidates") value = { entries: [] };
    else if (name === "language_analysis") value = { units: JSON.parse(body.input).map((b) => ({ block_id: b.block_id, segments: [{ text: b.source, language: "en", reason: "English fixture" }] })) };
    else if (name === "translation_qa") value = { summary: "ok", issues: [] };
    else value = { translations: JSON.parse(body.input.split("\n\n").at(-1)).map((b) => ({ block_id: b.block_id, translation: "完整译文。", source_questions: [], translator_notes: [] })) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }));
  });
  try {
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    process.env.OPENAI_API_KEY = "mock"; process.env.OPENAI_MODEL = "mock"; process.env.OPENAI_BASE_URL = baseUrl;
    await writeJson(path.join(root, "config/settings.json"), { openai: { model: "mock", baseUrl, stream: false, chunkMaxChars: 80, unitMaxChars: 80, semanticQa: true, requestAttempts: 1 }, recovery: { maxCycles: 1 } });
    const approved = structureMarkdown("First full sentence about a room.\n\nSecond full sentence about a street.");
    const languages = languageSettings({ sourceLanguages: ["en", "pinyin", "zh-Hans"], targetLanguage: "zh-Hans" });
    const plan = buildTranslationPlan(parseStructuredMarkdown(approved), 80), chunks = chunkBlocks(plan.units, 80);
    assert.equal(chunks.length, 2);
    const chunkDirectory = `05_bilingual/runs/${plan.version}/${sha256(JSON.stringify(languages))}/chunks`;
    await analyzeLanguages({ blocks: chunks[0], context: languages, cacheDir: path.join(dir, chunkDirectory, "requests"), client: {
      model: "mock", baseUrl, analyzeLanguages: async (blocks) => ({ value: { units: blocks.map((b) => ({ block_id: b.block_id, segments: [{ text: b.source, language: "en", reason: "English fixture" }] })) } })
    } });
    await writeText(path.join(dir, "approved.md"), approved);
    for (const file of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(dir, "00_shared", file), "Translate faithfully.");
    await writeJson(path.join(dir, "manifest.json"), { projectId: "book", createdAt: new Date().toISOString(), status: "translation_paused", languages,
      source: { approvedFile: "approved.md", approvedSha256: sha256(approved) }, openai: { model: "mock", baseUrl, ...languages, translationPlan: { version: plan.version, maxChars: 80 }, chunkDirectory } });
    await writeJson(path.join(root, ".runtime/task.json"), { id: "old-paused-task", projectId: "book", type: "translation", state: "paused", cycle: 1 });
    await writeJson(path.join(root, ".runtime/old-paused-task.pause.json"), { requestedAt: new Date().toISOString() });
    await recoverTask(root);
    assert.equal((await taskState(root)).state, "paused");
    web = createWebServer({ root, configLoader: () => loadConfig(root) });
    await new Promise((r) => web.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${web.address().port}`;
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.active, null); assert.equal(state.config.translationReady, true);
    assert.deepEqual(state.projects[0].languages, languages); assert.equal(state.projects[0].languagesLocked, true);
    assert.deepEqual(calls, [], "opening the app never resumes paused work");
    const response = await fetch(base + "/api/projects/book/translate", { method: "POST", headers: { "X-Local-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify(languages) });
    assert.equal(response.status, 202);
    const finished = await until(async () => { const t = await taskState(root); return ["completed", "needs_attention"].includes(t.state) && t; });
    assert.equal(finished.state, "completed", finished.error); assert.notEqual(finished.id, "old-paused-task");
    assert.equal(calls.filter((x) => x === "language_analysis").length, 1, "first cached batch is not submitted again");
    assert.equal(calls.filter((x) => x === "translation_chunk").length, 2);
    assert.equal(calls.filter((x) => x === "translation_qa").length, 2);
    assert.deepEqual((await readJson(path.join(dir, "manifest.json"))).languages, languages);
  } finally {
    if (web) await new Promise((r) => { web.close(r); web.closeAllConnections(); });
    const task = await taskState(root).catch(() => null);
    if (task?.workerAlive) { try { process.kill(task.pid); } catch {} }
    await new Promise((r) => { upstream.close(r); upstream.closeAllConnections(); });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await until(async () => !(await taskState(root))?.workerAlive).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("background recheck permits human edits and never promotes an outdated AI result to the current draft", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-worker-")), dir = path.join(root, "projects/book");
  const savedEnv = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((k) => [k, process.env[k]]));
  let pending, request;
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    request = JSON.parse(raw); pending = res;
  });
  try {
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.OPENAI_API_KEY = "mock"; process.env.OPENAI_MODEL = "mock";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
    await writeJson(path.join(root, "config/settings.json"), { openai: { stream: false, chunkMaxChars: 3000, timeoutMs: 10000 }, translation: { targetLanguage: "中文" }, recovery: { maxCycles: 1 } });
    for (const file of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(dir, "00_shared", file), "Respect human text.");
    await writeJson(path.join(dir, "manifest.json"), { status: "completed", source: {} });
    await writeJson(path.join(dir, "04_qa/review-document.json"), { version: "v1", issues: [], units: [
      { id: "u1", blockId: "U000001", source: "A coworker.", target: "一个同事。", scope: "body", section: "正文", issueIds: [], sourceMarks: [], targetMarks: [] }
    ] });
    await startTask(root, { type: "review", projectId: "book", mode: "all" });
    await until(() => pending);
    assert.equal(request.text.format.name, "translation_qa");
    assert.match(request.input, /一个同事/);
    assert.equal(await translationOwner(root), null, "AI review must not hold the human edit lock");
    await applyReviewEdit(dir, { version: "v1", revision: 0, unitId: "u1", before: "一个同事。", target: "一个“同事”（coworker）。" }, { root });
    pending.setHeader("Content-Type", "application/json");
    pending.end(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ issues: [], summary: "ok" }) }] }] }));
    await until(async () => (await taskState(root)).state === "completed");
    const result = await reviewSnapshot(dir);
    assert.equal(result.model.units[0].target, "一个“同事”（coworker）。");
    assert.equal(result.model.units[0].qa.state, "stale");
    assert.equal(result.model.units[0].qa.basisRevision, 0);
    assert.equal(result.edits.revision, 1);
  } finally {
    const task = await taskState(root).catch(() => null);
    if (task?.workerAlive) { try { process.kill(task.pid); } catch {} }
    pending?.destroy();
    await new Promise((r) => { upstream.close(r); upstream.closeAllConnections(); });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await until(async () => !(await taskState(root))?.workerAlive).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("durable worker survives web restart, resumes a crashed request without retranslating saved work, and completes QA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-worker-'));
  const dir = path.join(root, 'projects/book');
  const savedEnv = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].map((key) => [key, process.env[key]]));
  const counts = new Map();
  let hold = true, pendingResponse;
  let web;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (body.text.format.name === 'terminology_candidates') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ entries: [] }) }] }] }));
      return;
    }
    if (body.text.format.name === 'language_analysis') {
      const units = JSON.parse(body.input);
      counts.set('language', (counts.get('language') || 0) + 1);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ units: units.map((u) => ({ block_id: u.block_id, segments: [{ text: u.source, language: 'en', reason: 'English fixture' }] })) }) }] }] }));
      return;
    }
    const review = body.text.format.name === 'translation_qa';
    const units = review ? JSON.parse(body.input.match(/源文：([\s\S]+)\n\n译文：/)[1]) : JSON.parse(body.input.split('\n\n').at(-1));
    const key = `${review ? 'qa' : 'text'}:${units.map((b) => b.block_id).join(',')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!review && units[0].block_id === 'U000002' && hold) { pendingResponse = res; return; }
    const value = review ? { summary: 'ok', issues: [] } : { translations: units.map((u) => ({ block_id: u.block_id, translation: '完整译文。', source_questions: [], translator_notes: [] })) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: key, status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
  });
  const closeWeb = async () => { if (web) { const old = web; web = null; await new Promise((resolve) => { old.once('exit', resolve); old.kill(); }); } };
  const startWeb = async () => {
    const script = `import {createWebServer} from ${JSON.stringify(new URL('../src/web-server.mjs', import.meta.url).href)}; import {loadConfig} from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)}; const root=process.argv[1]; const server=createWebServer({root,configLoader:()=>loadConfig(root)}); server.listen(0,'127.0.0.1',()=>console.log('PORT:'+server.address().port));`;
    web = spawn(process.execPath, ['--input-type=module', '-e', script, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    web.stdout.on('data', (data) => { output += data; });
    web.stderr.on('data', (data) => { output += data; });
    const port = await until(() => output.match(/PORT:(\d+)/)?.[1]);
    return `http://127.0.0.1:${port}`;
  };
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    process.env.OPENAI_API_KEY = 'mock-key'; process.env.OPENAI_MODEL = 'mock';
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
    await writeJson(path.join(root, 'config/settings.json'), { translation: { targetLanguage: '简体中文' }, openai: { chunkMaxChars: 80, unitMaxChars: 80, stream: false, semanticQa: true, timeoutMs: 20000, requestAttempts: 1 }, recovery: { maxCycles: 3, cooldownMs: 10 } });
    const approved = structureMarkdown('First full sentence about a room.\n\nSecond full sentence about a street.');
    for (const file of ['workflow.md', 'style-guide.md', 'glossary.md']) await writeText(path.join(dir, '00_shared', file), 'Translate faithfully.');
    await writeText(path.join(dir, 'approved.md'), approved);
    await writeJson(path.join(dir, 'manifest.json'), { projectId: 'book', createdAt: new Date().toISOString(), status: 'source_approved', source: { approvedFile: 'approved.md', approvedSha256: sha256(approved) } });
    let base = await startWeb();
    const response = await fetch(`${base}/api/projects/book/translate`, { method: 'POST', headers: { 'x-local-request': '1' } });
    assert.equal(response.status, 202);
    await until(() => pendingResponse);
    assert.equal(counts.get('text:U000001'), 1);
    await closeWeb();
    assert.ok((await taskState(root)).workerAlive);
    assert.equal((await translationOwner(root)).projectId, 'book');
    const previousPid = (await taskState(root)).pid;
    process.kill(previousPid);
    pendingResponse.destroy(); pendingResponse = null; hold = false;
    await until(async () => !(await taskState(root)).workerAlive);
    base = await startWeb();
    const finished = await until(async () => { const task = await taskState(root); return task?.state === 'completed' && task; });
    assert.notEqual(finished.pid, previousPid);
    assert.equal(counts.get('text:U000001'), 1);
    assert.equal(counts.get('text:U000002'), 2);
    assert.equal(counts.get('qa:U000001'), 1);
    assert.equal(counts.get('qa:U000002'), 1);
    assert.equal(counts.get('language'), 2, 'completed language analyses are reused after restart');
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.openai.translatedChunks, 2);
    assert.equal(manifest.openai.reviewedChunks, 2);
    assert.match(await readFile(path.join(dir, manifest.outputs.chinese), 'utf8'), /完整译文/);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.task.state, 'completed');
  } finally {
    await closeWeb();
    const task = await taskState(root).catch(() => null);
    if (task?.workerAlive) { try { process.kill(task.pid); } catch {} }
    pendingResponse?.destroy();
    await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await until(async () => !(await taskState(root))?.workerAlive).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("pause survives restart and ambiguous OCR submission is never repeated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-pause-'));
  const dir = path.join(root, 'projects/book');
  try {
    await writeJson(path.join(root, 'config/settings.json'), { openai: {}, recovery: { maxCycles: 2 }, paddle: { baseUrl: 'https://unused.invalid' } });
    await writeJson(path.join(dir, 'manifest.json'), { projectId: 'book', status: 'ocr_failed', preparation: { requestedMode: 'ocr', method: 'ocr' }, source: { fileUrl: 'https://unused.invalid/book.pdf' }, paddle: { submissionStartedAt: new Date().toISOString() } });
    // Pause a queued task before its first request, then ensure recovery respects it.
    const queued = { id: 'test-task', projectId: 'book', type: 'preparation', state: 'queued', cycle: 0, createdAt: '2020-01-01T00:00:00Z' };
    await writeJson(path.join(root, '.runtime/task.json'), queued);
    await pauseTask(root, 'book');
    await recoverTask(root);
    await until(async () => (await taskState(root))?.state === 'paused');
    await until(async () => !(await taskState(root)).workerAlive);
    await recoverTask(root);
    assert.equal((await taskState(root)).state, 'paused');
    const before = process.env.PADDLEOCR_ACCESS_TOKEN;
    process.env.PADDLEOCR_ACCESS_TOKEN = 'mock';
    try { await startTask(root, { type: 'preparation', projectId: 'book' }); }
    finally { if (before === undefined) delete process.env.PADDLEOCR_ACCESS_TOKEN; else process.env.PADDLEOCR_ACCESS_TOKEN = before; }
    await until(async () => (await taskState(root))?.state === 'needs_attention');
    assert.equal((await taskState(root)).code, 'SUBMISSION_UNKNOWN');
  } finally {
    const task = await taskState(root).catch(() => null);
    if (task?.workerAlive) { try { process.kill(task.pid); } catch {} }
    await until(async () => !(await taskState(root))?.workerAlive).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("worker cooldown recovers transient failure but authentication and exhausted budgets stop", async () => {
  for (const scenario of ['recover', 'auth', 'exhaust']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worker-budget-'));
    const dir = path.join(root, 'projects/book');
    const savedEnv = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].map((key) => [key, process.env[key]]));
    let calls = 0, firstRequestAt;
    const upstream = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      calls++;
      firstRequestAt ||= Date.now();
      if (scenario === 'auth') { res.writeHead(401); res.end('unauthorized'); return; }
      if (scenario === 'exhaust' || calls === 1) { req.socket.destroy(); return; }
      const input = JSON.parse(body);
      const units = JSON.parse(input.input.split('\n\n').at(-1));
      res.setHeader('content-type', 'application/json');
      const value = input.text.format.name === 'terminology_candidates' ? { entries: [] } : input.text.format.name === 'language_analysis' ? { units: units.map((u) => ({ block_id: u.block_id, segments: [{ text: u.source, language: 'en', reason: 'English fixture' }] })) }
        : { translations: units.map((u) => ({ block_id: u.block_id, translation: '成功。', source_questions: [], translator_notes: [] })) };
      res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
    });
    try {
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      process.env.OPENAI_API_KEY = 'mock'; process.env.OPENAI_MODEL = 'mock'; process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
      await writeJson(path.join(root, 'config/settings.json'), { openai: { chunkMaxChars: 200, stream: false, semanticQa: false, requestAttempts: 1 }, translation: { targetLanguage: '简体中文' }, recovery: { maxCycles: 2, cooldownMs: 1 } });
      const source = structureMarkdown('A complete sentence.');
      await writeText(path.join(dir, 'approved.md'), source);
      for (const file of ['workflow.md', 'style-guide.md', 'glossary.md']) await writeText(path.join(dir, '00_shared', file), 'Translate.');
      const savedDeadline = Date.now() + (scenario === 'auth' ? 250 : 0);
      await writeJson(path.join(dir, 'manifest.json'), { status: 'source_approved', projectId: 'book', source: { approvedFile: 'approved.md', approvedSha256: sha256(source) },
        openai: { request: { state: 'retry_wait', nextRetryAt: new Date(savedDeadline).toISOString() } } });
      await writeJson(path.join(root, '.runtime/task.json'), { id: 'test', projectId: 'book', type: 'translation', state: 'queued', cycle: 0, createdAt: new Date().toISOString() });
      await runTask(root, 'test');
      const task = await taskState(root);
      assert.equal(task.state, scenario === 'recover' ? 'completed' : 'needs_attention');
      assert.equal(calls, scenario === 'auth' ? 1 : scenario === 'recover' ? 4 : 2);
      assert.equal(task.cycle, scenario === 'auth' ? 1 : 2);
      assert.ok(firstRequestAt >= savedDeadline);
    } finally {
      await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  }
});
