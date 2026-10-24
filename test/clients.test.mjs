import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PaddleCloudClient, parsePaddleOcrJsonl } from "../src/paddle-client.mjs";
import { OpenAIClient } from "../src/openai-client.mjs";
import { requestJson } from "../src/http-json.mjs";

test("Paddle client submits a local file and reads a completed job", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paddle-client-"));
  const file = path.join(dir, "page.pdf");
  await writeFile(file, "test");
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (options.method === "POST") {
      return Response.json({ code: 0, data: { jobId: "job-1" } });
    }
    return Response.json({ code: 0, data: { state: "done", resultUrl: { markdownUrl: "https://example.test/result.md" } } });
  };
  const client = new PaddleCloudClient({ token: "secret", baseUrl: "https://example.test", pollIntervalMs: 1, fetchImpl });
  try {
    const submitted = await client.submitFile(file, { model: "PP-StructureV3" });
    const completed = await client.waitForJob(submitted.data.jobId);
    assert.equal(completed.data.state, "done");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
    assert.equal(requests[0].options.body.get("file").type, "application/pdf");
    const wire = await new Request("https://example.test", requests[0].options).text();
    assert.match(wire, /Content-Type: application\/pdf/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permanent HTTP errors and malformed successful responses are not retried", async () => {
  for (const status of [400, 401, 403, 404, 200]) {
    let requests = 0;
    await assert.rejects(requestJson("https://example.test", { method: "POST" }, {
      secret: "secret-token", fetchImpl: async () => {
        requests += 1;
        return new Response("failure secret-token", { status });
      }
    }), (error) => {
      assert.equal(error.diagnostics.attempts.length, 1);
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /secret-token/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("temporary HTTP errors use bounded backoff and recover", async () => {
  let requests = 0;
  const waits = [];
  const result = await requestJson("https://example.test", {}, {
    sleepImpl: async (delay) => waits.push(delay),
    fetchImpl: async () => {
      requests += 1;
      if (requests < 3) return new Response("server busy", { status: requests === 1 ? 429 : 503 });
      return Response.json({ ok: true });
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(waits, [1000, 2000]);
});

test("OpenAI authentication errors and Paddle business errors are not retried", async () => {
  let requests = 0;
  const client = new OpenAIClient({ apiKey: "dummy", model: "test", fetchImpl: async () => {
    requests += 1;
    return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  } });
  await assert.rejects(client.structuredRequest("test", {}, "", ""), /HTTP 401/);
  assert.equal(requests, 1);
  const paddle = new PaddleCloudClient({ token: "dummy", baseUrl: "https://example.test", fetchImpl: async () => {
    requests += 1;
    return Response.json({ code: 123, message: "invalid input" });
  } });
  await assert.rejects(paddle.getJob("test"), /业务错误/);
  assert.equal(requests, 2);
});

test("Paddle client submits a file URL as JSON", async () => {
  let request;
  const fetchImpl = async (url, options = {}) => {
    request = { url: String(url), options };
    return Response.json({ code: 0, data: { jobId: "job-url-1" } });
  };
  const client = new PaddleCloudClient({ token: "secret", baseUrl: "https://example.test", fetchImpl });
  const submitted = await client.submitUrl("https://files.example.test/book.pdf", {
    model: "PaddleOCR-VL-1.6",
    optionalPayload: { useDocOrientationClassify: false }
  });

  assert.equal(submitted.data.jobId, "job-url-1");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), {
    fileUrl: "https://files.example.test/book.pdf",
    model: "PaddleOCR-VL-1.6",
    optionalPayload: { useDocOrientationClassify: false }
  });
});

test("Paddle JSONL result is converted to Markdown and image indexes", () => {
  const jsonl = JSON.stringify({
    result: {
      layoutParsingResults: [{
        markdown: {
          text: "# Page 1\n\nText",
          images: { "images/page-1.jpg": "https://example.test/page-1.jpg" }
        },
        outputImages: { page: "https://example.test/output-1.jpg" }
      }]
    }
  });
  const extracted = parsePaddleOcrJsonl(`${jsonl}\n`);

  assert.equal(extracted.markdown, "<!-- pdf_page: 1 -->\n\n# Page 1\n\nText\n");
  assert.deepEqual(extracted.markdownImages.map((item) => item.relativePath), ["images/page-1.jpg"]);
  assert.deepEqual(extracted.outputImages.map((item) => item.name), ["page"]);
});

test("all AI entry points check source artifacts while preserving legacy review quotations", async () => {
  const requests = [];
  const source = 'A complete scene.16 Another scene.17 The final scene.18';
  const client = new OpenAIClient({ apiKey: 'test', model: 'test', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const value = body.text.format.name === 'translation_qa'
      ? { issues: [{ block_id: 'B1', source_quote: 'scene.[^16] Another', translation_quote: '', severity: 'warning', category: 'meaning', description: 'Test', recommendation: 'Test' }] }
      : body.text.format.name === 'paragraph_revision' ? { translation: '译文。', explanation: '说明' }
        : { translations: [{ block_id: 'B1', translation: '译文。', source_questions: [], translator_notes: [] }] };
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  } });
  const context = { targetLanguage: '中文', workflow: '', styleGuide: '', glossary: '' };
  await client.translate([{ block_id: 'B1', source }], context);
  const reviewed = await client.review([{ block_id: 'B1', source }], [{ block_id: 'B1', translation: '人工文本。' }], context);
  await client.revise({ source, translation: '人工文本。', context: [] }, context);
  assert.equal(reviewed.value.issues[0].source_quote, 'scene.16 Another');
  for (const body of requests) {
    assert.match(body.input, /scene\.\[\^16\]/);
    assert.doesNotMatch(body.input, /scene\.16/);
    assert.match(body.instructions, /不是正文数值/);
  }
  for (const body of requests.filter((r) => ["translation_chunk", "translation_qa"].includes(r.text.format.name))) {
    assert.match(body.instructions, /numeric 类别只能使用最低级 note/);
    assert.match(body.instructions, /1940s/);
    assert.match(body.instructions, /标题词拼成单位/);
  }
});

test("OpenAI client requests a strict structured response", async () => {
  let requestUrl;
  let requestBody;
  const fetchImpl = async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    return Response.json({
      id: "resp-1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ translations: [{ block_id: "B1", translation: "译文", source_questions: [], translator_notes: [] }] }) }] }]
    });
  };
  const client = new OpenAIClient({
    apiKey: "secret",
    model: "test-model",
    baseUrl: "https://relay.example.test/v1/",
    fetchImpl
  });
  const result = await client.translate([{ block_id: "B1", source: "Source" }], {
    targetLanguage: "简体中文",
    workflow: "不得把相邻块的信息擅自写入当前块。",
    styleGuide: "style",
    glossary: "glossary"
  });
  assert.equal(requestUrl, "https://relay.example.test/v1/responses");
  assert.equal(result.value.translations[0].block_id, "B1");
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.store, false);
  assert.match(requestBody.instructions, /分组规则优先于旧工作规程/);
  assert.match(requestBody.input, /不必按原始页码或 sourceSpans 分段/);
});
