import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readResponseStream } from "../src/response-stream.mjs";
import { runTranslationJob, mapWorkers, cachedTranslationUnits } from "../src/translation-jobs.mjs";
import { withTranslationLock, translationOwner } from "../src/translation-lock.mjs";

function streamResponse(events, completed = true) {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("") + (completed ? "data: [DONE]\r\n\r\n" : ""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 1) controller.enqueue(bytes.slice(i, i + 1));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("streaming handles split UTF-8 and CRLF; requires completed event", async () => {
  const progress = [];
  const final = { status: "completed", output: [{ content: [{ type: "output_text", text: "中文" }] }] };
  assert.deepEqual(await readResponseStream(streamResponse([
    { type: "response.output_text.delta", delta: "中文" }, { type: "response.completed", response: final }
  ]), (p) => progress.push(p)), final);
  assert.equal(progress[0].receivedCharacters, 2);
  await assert.rejects(readResponseStream(streamResponse([{ type: "response.output_text.delta", delta: "partial" }], false)), { code: "STREAM_INTERRUPTED" });
  await assert.rejects(readResponseStream(streamResponse([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])), { code: "INCOMPLETE_RESPONSE" });
  await assert.rejects(readResponseStream(streamResponse([{ type: "error", message: "Concurrency limit exceeded for user" }])), { code: "CONCURRENCY_LIMIT" });
});

test("524 splits sequentially, reuses successful children after interruption, and never accepts mismatched ids", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "translation-recovery-"));
  let calls = [];
  let failSecond = true;
  const client = { model: "test", baseUrl: "test", async translate(blocks) {
    calls.push(blocks.map((b) => b.block_id).join(","));
    if (blocks.length > 1) throw Object.assign(new Error("timeout"), { status: 524 });
    if (blocks[0].block_id === "B2" && failSecond) throw new Error("connection interrupted");
    return { value: { translations: blocks.map((b) => ({ block_id: b.block_id, translation: "译文" })) } };
  } };
  const options = { client, cacheDir, context: {}, blocks: [{ block_id: "B1", source: "one" }, { block_id: "B2", source: "two" }] };
  try {
    await assert.rejects(runTranslationJob(options), /interrupted/);
    assert.deepEqual((await cachedTranslationUnits(options)).map((t) => t.block_id), ["B1"]);
    assert.deepEqual(await cachedTranslationUnits({ ...options, context: { targetLanguage: "en" } }), []);
    failSecond = false;
    const value = await runTranslationJob(options);
    assert.deepEqual(calls, ["B1,B2", "B1", "B2", "B2"]);
    assert.deepEqual(value.translations.map((b) => b.block_id), ["B1", "B2"]);
    await runTranslationJob(options);
    assert.equal(calls.length, 4);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test("capacity errors back off without splitting and locks cover independent entry points", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "translation-lock-"));
  const waits = [];
  let calls = 0;
  const client = { model: "test", baseUrl: "test", async translate(blocks) {
    calls++;
    if (calls === 1) throw Object.assign(new Error("capacity"), { code: "CONCURRENCY_LIMIT" });
    return { value: { translations: blocks.map((b) => ({ block_id: b.block_id, translation: "译文" })) } };
  } };
  try {
    await runTranslationJob({ client, blocks: [{ block_id: "B1", source: "a" }], context: {}, cacheDir: root, sleepImpl: async (ms) => waits.push(ms) });
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 24000 && waits[0] <= 36000);
    await withTranslationLock("project-a", async () => {
      assert.equal((await translationOwner(root)).projectId, "project-a");
      await assert.rejects(withTranslationLock("project-b", () => assert.fail(), { root }), { code: "TRANSLATION_BUSY" });
      const moduleUrl = new URL("../src/translation-lock.mjs", import.meta.url).href;
      const code = `import{withTranslationLock}from ${JSON.stringify(moduleUrl)};try{await withTranslationLock('other-process',()=>{}, {root:${JSON.stringify(root)}});process.exitCode=2}catch(e){if(e.code!=='TRANSLATION_BUSY')throw e;console.log('blocked')}`;
      const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code]);
      assert.match(child.stdout, /blocked/);
    }, { root });
    await withTranslationLock("project-b", async () => {}, { root });
    assert.equal(await translationOwner(root), null);
    let active = 0, maximum = 0;
    await mapWorkers([1, 2, 3], 1, async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; });
    assert.equal(maximum, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
