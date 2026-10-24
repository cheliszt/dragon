import http from "node:http";
import path from "node:path";
import { APP_ROOT } from "./config.mjs";
import { sha256 } from "./utils.mjs";

const APPLICATION = "translation-workflow-lock-v1";
const portFor = (root) => 45000 + parseInt(sha256(path.resolve(root).toLowerCase()).slice(0, 6), 16) % 10000;

export async function translationOwner(root = APP_ROOT) {
  try {
    const response = await fetch(`http://127.0.0.1:${portFor(root)}/status`, { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    return data.application === APPLICATION ? data.owner : null;
  } catch { return null; }
}

// An exclusive listening socket is released by the OS even if the worker crashes.
export async function withTranslationLock(projectDir, operation, { root = APP_ROOT, details = {} } = {}) {
  const owner = { name: "翻译与质检", projectId: path.basename(projectDir), pid: process.pid, startedAt: new Date().toISOString(), ...details };
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/status") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ application: APPLICATION, owner }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: portFor(root), host: "127.0.0.1", exclusive: true }, resolve);
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    throw Object.assign(new Error("已有翻译进程正在运行，请等待它完成；不会重复提交。"), { status: 409, code: "TRANSLATION_BUSY" });
  }
  try { return await operation(); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}
