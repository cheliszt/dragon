// Local-only UI fixture: the mock returns a rate limit; no paid API is contacted.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createWebServer } from "../src/web-server.mjs";
import { loadConfig } from "../src/config.mjs";
import { writeJson, writeText, sha256, sleep } from "../src/utils.mjs";
import { structureMarkdown } from "../src/markdown.mjs";
import { pauseTask, taskState } from "../src/task-manager.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), 'stability-ui-'));
const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end(JSON.stringify({ error: { message: 'Test rate limit' } })); });
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_API_KEY = 'local-fixture'; process.env.OPENAI_MODEL = 'local-fixture';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
await writeJson(path.join(root, 'config/settings.json'), { openai: { chunkMaxChars: 500, unitMaxChars: 200, requestAttempts: 2, stream: false }, translation: { targetLanguage: '简体中文' }, recovery: { maxCycles: 2 } });
const dir = path.join(root, 'projects/stability-test');
const approved = structureMarkdown('This is a complete local test sentence.');
await writeText(path.join(dir, 'approved.md'), approved);
for (const name of ['workflow.md', 'glossary.md', 'style-guide.md']) await writeText(path.join(dir, '00_shared', name), 'Translate.');
await writeJson(path.join(dir, 'manifest.json'), { projectId: 'stability-test', createdAt: new Date().toISOString(), status: 'source_approved', source: { candidateFile: 'approved.md', approvedFile: 'approved.md', approvedSha256: sha256(approved) } });
const server = createWebServer({ root, configLoader: () => loadConfig(root) });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
console.log(`Fixture URL: http://127.0.0.1:${server.address().port}/`);
async function close() {
  const task = await taskState(root);
  if (task?.active) await pauseTask(root, task.projectId);
  const deadline = Date.now() + 5000;
  while ((await taskState(root))?.workerAlive && Date.now() < deadline) await sleep(100);
  if ((await taskState(root))?.workerAlive) throw new Error('Fixture worker still alive; preserve files.');
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
}
process.once('SIGINT', () => close().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); }));
