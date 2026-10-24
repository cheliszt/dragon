import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestJson } from "../src/http-json.mjs";
import { retryAfterMs } from "../src/reliability.mjs";
import { readResponseStream } from "../src/response-stream.mjs";
import { runTranslationJob } from "../src/translation-jobs.mjs";
import { writeJson } from "../src/utils.mjs";
import { PaddleCloudClient } from "../src/paddle-client.mjs";
import { resumePreparation } from "../src/pipeline.mjs";

test("local network permission denial is actionable and never retried as a provider outage", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    let calls = 0;
    await assert.rejects(requestJson("https://local.test", {}, { secret: "private-key", fetchImpl: async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed private-key"), { cause: { code, message: "connect denied private-key" } });
    } }), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, /本机权限限制/);
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-key/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("GET retries a dropped connection with fresh signals; unknown POST delivery is not repeated", async () => {
  const signals = [], waits = [];
  const fetchImpl = async (_, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return Response.json({ ok: true });
  };
  assert.equal((await requestJson('http://local.test', {}, { fetchImpl, sleepImpl: async (ms) => waits.push(ms) })).ok, true);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false);
  assert.equal(waits.length, 1);
  let calls = 0;
  await assert.rejects(requestJson('http://local.test', { method: 'POST' }, { fetchImpl: async () => {
    calls++; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' });
  } }), { code: 'ECONNRESET' });
  assert.equal(calls, 1);
});

test("each timeout gets a new deadline and Retry-After dates are honored", async () => {
  let calls = 0;
  const result = await requestJson('http://local.test', {}, { timeoutMs: 10, sleepImpl: async () => {}, fetchImpl: async (_, { signal }) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    assert.equal(signal.aborted, false); return Response.json({ ok: true });
  } });
  assert.equal(result.ok, true);
  assert.equal(retryAfterMs('Fri, 18 Sep 2026 00:02:00 GMT', Date.parse('2026-09-18T00:00:00Z')), 120000);
  const waits = [];
  let busy = true;
  await requestJson('http://local.test', {}, { sleepImpl: async (ms) => waits.push(ms), fetchImpl: async () => {
    if (busy) { busy = false; return new Response('busy', { status: 429, headers: { 'retry-after': '90' } }); }
    return Response.json({});
  } });
  assert.deepEqual(waits, [90000]);
});

test("quota and TLS failures stop without repeated requests", async () => {
  for (const failure of [() => Response.json({ error: { code: 'insufficient_quota', message: 'quota' } }, { status: 429 }),
    () => { throw Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }); }]) {
    let calls = 0;
    await assert.rejects(requestJson('http://local.test', {}, { fetchImpl: async () => { calls++; return failure(); } }));
    assert.equal(calls, 1);
  }
});

test("stream idle timeout cancels the reader and partial content is never returned", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(readResponseStream(response, () => {}, { idleTimeoutMs: 10 }), { code: 'STREAM_IDLE_TIMEOUT' });
  assert.equal(cancelled, true);
});

test("single complete sentence retries transient failures, reports progress, and reuses its durable result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retry-one-'));
  const events = [], waits = [];
  let calls = 0;
  const client = { model: 'test', baseUrl: 'test', async translate(blocks) {
    if (++calls < 3) throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    return { value: { translations: blocks.map((b) => ({ block_id: b.block_id, translation: '完整译文。' })) } };
  } };
  const options = { client, blocks: [{ block_id: 'U1', source: 'One complete sentence.' }], context: {}, cacheDir: root,
    onEvent: async (e) => events.push(e), sleepImpl: async (ms) => waits.push(ms) };
  try {
    await runTranslationJob(options); await runTranslationJob(options);
    assert.equal(calls, 3); assert.equal(waits.length, 2);
    assert.equal(events.filter((e) => e.state === 'retry_wait').length, 2);
    assert.equal(events.at(-1).state, 'cached');
    assert.equal((await readdir(root)).filter((f) => f.endsWith('.json')).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("atomic concurrent writes never expose torn JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atomic-json-'));
  const target = path.join(root, 'state.json');
  try {
    await writeJson(target, { value: 0 });
    await Promise.all(Array.from({ length: 10 }, (_, value) => writeJson(target, { value, padding: 'x'.repeat(10000) })));
    assert.equal(typeof JSON.parse(await readFile(target, 'utf8')).value, 'number');
    assert.deepEqual(await readdir(root), ['state.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OCR submit is not repeated after 503; downloads retry and publish only whole files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-network-'));
  let calls = 0;
  const client = new PaddleCloudClient({ baseUrl: 'https://local.test', token: 'secret', sleepImpl: async () => {}, fetchImpl: async (_, options) => {
    calls++;
    if (options.method === 'POST') return new Response('uncertain', { status: 503 });
    if (calls === 2) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    return new Response('complete image');
  } });
  try {
    await assert.rejects(client.submitUrl('https://local.test/book.pdf', { model: 'test' }));
    assert.equal(calls, 1);
    const file = path.join(root, 'image.jpg');
    await client.download('https://local.test/image', file);
    assert.equal(await readFile(file, 'utf8'), 'complete image');
    await client.download('https://local.test/image', file);
    assert.equal(calls, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OCR recovery polls its saved job ID and resumes result retrieval without re-upload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-resume-'));
  const dir = path.join(root, 'projects/book');
  const calls = [];
  const client = new PaddleCloudClient({ baseUrl: 'https://local.test', token: 'mock', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/saved-job')) return Response.json({ code: 0, data: { state: 'done', resultUrl: { markdownUrl: 'https://local.test/document.md' } } });
    return new Response('Recovered source text.');
  } });
  try {
    await writeJson(path.join(root, 'config/settings.json'), { openai: {}, paddle: {} });
    await writeJson(path.join(dir, 'manifest.json'), { projectId: 'book', status: 'ocr_failed', preparation: { requestedMode: 'ocr', method: 'ocr' }, source: { fileUrl: 'https://local.test/original.pdf' }, paddle: { jobId: 'saved-job', submissionStartedAt: new Date().toISOString() } });
    const result = await resumePreparation(dir, { root, paddleClient: client });
    assert.equal(result.manifest.status, 'source_review_required');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.method === 'GET'));
    assert.match(await readFile(path.join(dir, result.manifest.source.candidateFile), 'utf8'), /Recovered source text/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
