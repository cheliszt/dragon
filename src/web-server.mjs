import http from "node:http";
import { readFile, readdir, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { APP_ROOT, loadConfig } from "./config.mjs";
import { prepareSource, approveSource, translateProject } from "./pipeline.mjs";
import { parseStructuredMarkdown } from "./markdown.mjs";
import { translationOwner } from "./translation-lock.mjs";
import { startTask, taskState, recoverTask, pauseTask } from "./task-manager.mjs";
import { readJson, writeJson, writeText, safeName, sha256 } from "./utils.mjs";
import { reviewSnapshot, applyReviewEdit, applyAnnotationEdit } from "./review-edits.mjs";
import { annotatedMarkdown } from "./annotations.mjs";
import { renderReviewHtml } from "./reading-outputs.mjs";
import { exportPdf, exportWord } from "./document-export.mjs";
import { listProposals, startProposal } from "./review-proposals.mjs";
import { languageSettings, projectLanguages } from "./languages.mjs";
import { manageTerm } from "./term-management.mjs";

const UPLOAD_LIMIT = 50 * 1024 * 1024;
const DEFAULT_WORKFLOW = { prepareSource, approveSource, translateProject };
const CANDIDATE = "02_source_candidates/reconciled/document.md";
const OUTPUTS = {
  source: CANDIDATE,
  bilingual: "05_bilingual/project_bilingual.md",
  bilingualHtml: "05_bilingual/project_bilingual.html",
  chinese: "06_zh/project_zh.md",
  qa: "04_qa/final.md"
};
const STATIC = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/review.js": ["review.js", "text/javascript"], "/review.css": ["review.css", "text/css"], "/pdf-preview.js": ["pdf-preview.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
STATIC["/source-issues.js"] = ["source-issues.js", "text/javascript"];
STATIC["/source-review.js"] = ["source-review.js", "text/javascript"];
STATIC["/task-state.js"] = ["task-state.js", "text/javascript"];

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function reviewHtmlPolicy(res, html) {
  const hash = (text) => `'sha256-${Buffer.from(sha256(text), "hex").toString("base64")}'`;
  const scripts = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => hash(m[1]));
  const styles = [...String(html).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => hash(m[1]));
  // Permit only the exact generated inline assets, without enabling arbitrary inline scripts.
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' ${scripts.join(" ")}; style-src 'self' ${styles.join(" ")}; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`);
}

async function body(req, limit) {
  if (Number(req.headers["content-length"]) > limit) fail(413, "文件超过大小限制。PDF 最大 50 MB。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "文件超过大小限制。PDF 最大 50 MB。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The workflow can be substituted by local fixtures in tests, without calling paid APIs.
export function createWebServer({ root = APP_ROOT, configLoader = loadConfig,
  workflow = DEFAULT_WORKFLOW, revise, reviewDraft } = {}) {
  const durable = workflow === DEFAULT_WORKFLOW;
  const projectsRoot = path.join(root, "projects");
  let active = null;
  let lastError = null;

  async function project(id) {
    if (!id || id === "." || id === ".." || /[\\/:\x00]/.test(id)) fail(400, "项目编号无效。");
    const dir = path.join(projectsRoot, id);
    const actual = await realpath(dir);
    const actualRoot = await realpath(projectsRoot);
    if (path.dirname(actual) !== actualRoot) fail(403, "项目路径无效。");
    return { dir, manifest: await readJson(path.join(dir, "manifest.json")) };
  }

  async function projectFile(dir, relative) {
    const target = await realpath(path.resolve(dir, relative));
    const actualDir = await realpath(dir);
    if (!target.startsWith(actualDir + path.sep)) fail(403, "文件路径无效。");
    return target;
  }

  async function history() {
    let entries;
    try { entries = await readdir(projectsRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const items = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const { manifest } = await project(entry.name);
        return {
          id: entry.name, name: path.basename(manifest.source.originalFile || manifest.source.fileUrl || entry.name),
          status: manifest.status, createdAt: manifest.createdAt,
          languages: projectLanguages(manifest), languagesLocked: Boolean(manifest.openai),
          progress: manifest.paddle?.progress,
          preparation: manifest.preparation && {
            method: manifest.preparation.method, progress: manifest.preparation.progress,
            inspectedPages: manifest.preparation.textLayer?.inspectedPages,
            textPages: manifest.preparation.textLayer?.textPages,
            coverage: manifest.preparation.textLayer?.coverage,
            reviewPages: manifest.preparation.textLayer?.reviewPages
          },
          translation: manifest.openai && { total: manifest.openai.chunkCount, done: manifest.openai.completedChunks || 0,
            translated: manifest.openai.translatedChunks, reviewed: manifest.openai.reviewedChunks, detected: manifest.openai.detectedChunks, request: manifest.openai.request },
          terminologyProgress: manifest.terminologyProgress,
          sourceRetry: manifest.preparation?.retry,
          canResumeSource: !manifest.source.candidateFile && Boolean(manifest.paddle?.jobId || manifest.source.originalFile && !manifest.paddle?.submissionStartedAt),
          hasSource: Boolean(manifest.source.candidateFile),
          sourceVersion: manifest.source.normalization?.version || manifest.source.approvedSha256 || manifest.source.candidateSha256,
          normalization: manifest.source.normalization,
          hasOriginal: Boolean(manifest.source.originalFile), outputs: Object.keys(manifest.outputs || {}),
          error: manifest.error
        };
      } catch { return null; }
    }));
    return items.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function reserve(name, projectId = null) {
    if (active) fail(409, "已有任务正在处理，请等待完成。");
    lastError = null;
    active = { name, projectId, startedAt: new Date().toISOString() };
  }

  function background(operation) {
    Promise.resolve().then(operation).catch((error) => {
      lastError = { projectId: active?.projectId, message: error.message };
    }).finally(() => { active = null; });
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type.startsWith("application/json") ? JSON.stringify(value) : value);
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' data:; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try {
      // Restrict the local service to its own origin, including requests from other websites.
      const authority = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== authority) fail(403, "请使用本地启动地址访问。");
      if (req.headers.origin && req.headers.origin !== `http://${authority}`) fail(403, "不允许跨站请求。");
      if (!["GET", "POST"].includes(req.method)) fail(405, "不支持此请求方式。");
      if (req.method === "POST" && req.headers["x-local-request"] !== "1") fail(403, "请从本地网页提交。");
      const url = new URL(req.url, `http://${authority}`);
      const pdfAsset = url.pathname.match(/^\/vendor\/(?:(pdf(?:\.worker)?\.mjs)|(wasm|cmaps|standard_fonts)\/([a-zA-Z0-9_.-]+))$/);
      if (req.method === "GET" && pdfAsset) {
        const relative = pdfAsset[1] ? `build/${pdfAsset[1]}` : `${pdfAsset[2]}/${pdfAsset[3]}`;
        const type = relative.endsWith(".mjs") ? "text/javascript" : relative.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
        return send(200, await readFile(path.join(APP_ROOT, "node_modules/pdfjs-dist", relative)), type);
      }
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(200, await readFile(path.join(APP_ROOT, "web", file)), `${type}; charset=utf-8`);
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const config = await configLoader();
        const runningTranslation = await translationOwner(root);
        const task = durable ? await taskState(root) : null;
        return send(200, {
          config: {
            paddleReady: Boolean(process.env.PADDLEOCR_ACCESS_TOKEN?.trim()),
            translationReady: Boolean(process.env.OPENAI_API_KEY?.trim()),
            model: config.openai.model,
            provider: new URL(config.openai.baseUrl).hostname,
            projectsDir: projectsRoot
          }, active: active || runningTranslation || (task?.active ? { projectId: task.projectId, name: "后台任务" } : null),
          task, lastError, projects: await history()
        });
      }
      if (req.method === "POST" && url.pathname === "/api/upload") {
        await configLoader();
        let languages;
        try { languages = languageSettings(JSON.parse(req.headers["x-translation-languages"] || "{}")); } catch (e) { fail(400, e.status === 400 ? e.message : "语言设置格式无效。"); }
        const mode = req.headers["x-source-mode"] || "auto";
        if (!["auto", "text", "ocr"].includes(mode)) fail(400, "处理方式无效。");
        if (mode === "ocr" && !process.env.PADDLEOCR_ACCESS_TOKEN?.trim()) fail(400, "请先在 .env 填写 PADDLEOCR_ACCESS_TOKEN，然后重启服务。");
        const name = decodeURIComponent(req.headers["x-file-name"] || "document.pdf");
        if (!/\.pdf$/i.test(name)) fail(400, "请选择 PDF 文件。");
        reserve(name);
        let temp;
        try {
          const content = await body(req, UPLOAD_LIMIT);
          if (!content.subarray(0, 1024).includes(Buffer.from("%PDF-"))) fail(400, "文件不是有效的 PDF。");
          if (durable) {
            const projectId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${safeName(path.parse(path.basename(name)).name)}-${randomUUID().slice(0, 8)}`;
            const sourceFile = path.join(root, ".runtime/uploads", `${projectId}.pdf`);
            await writeText(sourceFile, content);
            const task = await startTask(root, { type: "preparation", projectId, sourceFile, mode, languages });
            active = null;
            return send(202, { accepted: true, projectId, taskId: task.id });
          }
          temp = await mkdtemp(path.join(os.tmpdir(), "translation-upload-"));
          const file = path.join(temp, `${safeName(path.parse(path.basename(name)).name)}.pdf`);
          await writeFile(file, content);
          background(async () => {
            try {
              await workflow.prepareSource(file, { mode, languages, onProjectCreated: (dir) => { active.projectId = path.basename(dir); } });
            } finally { await rm(temp, { recursive: true, force: true }); }
          });
          return send(202, { accepted: true });
        } catch (error) {
          active = null;
          if (temp) await rm(temp, { recursive: true, force: true });
          throw error;
        }
      }
      const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/(source|translate|file|review|recheck|edit|proposals|annotations|prepare-annotations|pause|resume-source|terms)$/);
      if (!match) fail(404, "未找到此页面或文件。");
      const [, encoded, action] = match;
      const id = decodeURIComponent(encoded);
      const { dir, manifest } = await project(id);
      if (action === "terms" && req.method === "POST") {
        let data;
        try { data = JSON.parse((await body(req, 512 * 1024)).toString("utf8")); } catch { fail(400, "术语请求格式无效。"); }
        if (!data || typeof data !== "object") fail(400, "术语请求格式无效。");
        return send(200, await manageTerm(dir, data, { root }));
      }
      if (action === "recheck" && req.method === "POST") {
        let data;
        try { data = JSON.parse((await body(req, 64 * 1024)).toString("utf8")); } catch { fail(400, "质检请求格式无效。"); }
        if (!data || typeof data !== "object") fail(400, "质检请求格式无效。");
        const snapshot = await reviewSnapshot(dir);
        if (data.version !== snapshot.model.version || data.revision !== snapshot.edits.revision) fail(409, "书稿已更新，请读取当前修订后再提交质检。");
        if (!["changed", "all"].includes(data.mode) || data.unitIds && (!Array.isArray(data.unitIds) || !data.unitIds.length
          || data.unitIds.some((id) => !snapshot.model.units.some((u) => u.id === id && !u.artifact)))) fail(400, "质检范围无效。");
        if (reviewDraft) return send(200, await reviewDraft(dir, { root, mode: data.mode, unitIds: data.unitIds }));
        await configLoader();
        if (!process.env.OPENAI_API_KEY?.trim()) fail(400, "请先配置 OPENAI_API_KEY。");
        const task = await startTask(root, { type: "review", projectId: id, mode: data.mode, unitIds: data.unitIds });
        return send(202, { accepted: true, taskId: task.id });
      }
      if (action === "prepare-annotations" && req.method === "POST") {
        if (active) fail(409, "已有操作正在处理。");
        const task = await startTask(root, { type: "annotations", projectId: id });
        return send(202, { accepted: true, taskId: task.id });
      }
      if (action === "edit" || action === "proposals" || action === "annotations") {
        if (action === "proposals" && req.method === "GET") {
          const snapshot = await reviewSnapshot(dir);
          return send(200, { proposals: await listProposals(dir, snapshot.model.version) });
        }
        if (req.method !== "POST") fail(405, "不支持此请求方式。");
        let data;
        try { data = JSON.parse((await body(req, 256 * 1024)).toString("utf8")); } catch { fail(400, "修订格式无效。"); }
        if (!data || typeof data !== "object") fail(400, "修订格式无效。");
        if (active) fail(409, "已有操作正在处理，请稍后重试。");
        if (action === "annotations") return send(200, await applyAnnotationEdit(dir, data, { root }));
        if (action === "edit") return send(200, await applyReviewEdit(dir, data, { root }));
        await configLoader();
        if (!revise && !process.env.OPENAI_API_KEY?.trim()) fail(400, "请先配置 OPENAI_API_KEY。");
        return send(202, await startProposal(dir, data, { root, revise }));
      }
      if (action === "pause" && req.method === "POST" && durable) {
        await pauseTask(root, id); return send(202, { accepted: true });
      }
      if (action === "resume-source" && req.method === "POST" && durable) {
        if (manifest.source.candidateFile) fail(409, "原文已生成。");
        if (!manifest.paddle?.jobId && manifest.paddle?.submissionStartedAt) fail(409, "OCR 提交结果不确定，不能自动重复上传。");
        if (active) fail(409, "已有操作正在处理。");
        const task = await startTask(root, { type: "preparation", projectId: id });
        return send(202, { accepted: true, taskId: task.id });
      }
      if (action === "review") {
        const snapshot = await reviewSnapshot(dir);
        const model = snapshot.model;
        const decisionPath = path.join(dir, "04_qa/review-decisions.json");
        const decisions = async () => { try { return await readJson(decisionPath); } catch (error) { if (error.code === "ENOENT") return { revision: 0 }; throw error; } };
        if (req.method === "GET") {
          const stored = await decisions();
          return send(200, { ...snapshot, proposals: await listProposals(dir, model.version), revision: stored.revision,
            state: stored.version === model.version ? stored : { version: model.version, issues: {}, scopes: {} } });
        }
        if (req.method === "POST") {
          reserve("保存审阅记录", id);
          try {
            let data;
            try { data = JSON.parse((await body(req, 2 * 1024 * 1024)).toString("utf8")); } catch { fail(400, "审阅记录格式无效。"); }
            if (data?.version !== model.version) fail(409, "读稿已更新，请刷新后重新核查。");
            const stored = await decisions();
            if (data.revision !== stored.revision) fail(409, "另一个窗口已更新审阅记录，请刷新后再保存。");
            const knownIssues = new Set([...model.issues.map((q) => q.id), ...Object.keys(stored.issues || {})]);
            const knownBlocks = new Set(model.units.map((u) => u.blockId));
            if (!data.issues || !data.scopes || Array.isArray(data.issues) || Array.isArray(data.scopes)) fail(400, "审阅记录格式无效。");
            for (const [key, value] of Object.entries(data.issues)) {
              if (!knownIssues.has(key) || !["pending", "reviewed", "dismissed"].includes(value?.status)
                || (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 5000))) fail(400, "审阅判断或备注无效。");
            }
            for (const [key, value] of Object.entries(data.scopes)) if (!knownBlocks.has(key) || !["body", "auxiliary"].includes(value)) fail(400, "内容归类无效。");
            const saved = { version: model.version, revision: stored.revision + 1, issues: data.issues, scopes: data.scopes, savedAt: new Date().toISOString() };
            await writeJson(decisionPath, saved);
            return send(200, { saved: true, revision: saved.revision });
          } finally { active = null; }
        }
      }
      if (action === "source" && req.method === "GET") {
        const relative = manifest.source.normalizedFile || manifest.source.approvedFile || CANDIDATE;
        return send(200, { text: await readFile(await projectFile(dir, relative), "utf8") });
      }
      if (action === "source" && req.method === "POST") {
        reserve("保存校对", id);
        try {
          if (manifest.status !== "source_review_required") fail(409, "此项目已批准或尚未完成识别，不能修改源文。");
          const source = (await body(req, 20 * 1024 * 1024)).toString("utf8");
          const original = parseStructuredMarkdown(await readFile(await projectFile(dir, CANDIDATE), "utf8"));
          const updated = parseStructuredMarkdown(source);
          if (!updated.length || JSON.stringify(original.map((b) => b.block_id)) !== JSON.stringify(updated.map((b) => b.block_id))) {
            fail(400, "请保留原文中的 block_id 标识和全部段落，仅修改段落文字。");
          }
          await writeText(path.join(dir, CANDIDATE), source);
          manifest.source.candidateSha256 = sha256(source);
          manifest.updatedAt = new Date().toISOString();
          await writeJson(path.join(dir, "manifest.json"), manifest);
          return send(200, { saved: true });
        } finally { active = null; }
      }
      if (action === "translate" && req.method === "POST") {
        await configLoader();
        if (await translationOwner(root)) fail(409, "已有翻译进程正在运行，请等待它完成。");
        if (!process.env.OPENAI_API_KEY?.trim()) fail(400, "请先在 .env 填写 OPENAI_API_KEY，然后重启服务。");
        if (!["source_review_required", "source_approved", "translation_failed", "translation_paused", "qa_failed", "translating"].includes(manifest.status)) fail(409, "当前项目不能开始翻译。");
        let languages;
        try {
          const raw = (await body(req, 4096)).toString("utf8");
          languages = raw ? languageSettings(JSON.parse(raw)) : projectLanguages(manifest);
        } catch (e) { fail(400, e.status === 400 ? e.message : "语言设置格式无效。"); }
        if (manifest.openai && JSON.stringify(languages) !== JSON.stringify(projectLanguages(manifest))) fail(409, "翻译已开始，继续任务需沿用原语言设置；更改语种请新建项目，以保留已有修订。");
        reserve("翻译与质检", id);
        try { manifest.languages = languages; await writeJson(path.join(dir, "manifest.json"), manifest); }
        catch (e) { active = null; throw e; }
        if (durable) {
          try {
            if (manifest.status === "source_review_required") await workflow.approveSource(dir);
            const task = await startTask(root, { type: "translation", projectId: id });
            return send(202, { accepted: true, taskId: task.id });
          } finally { active = null; }
        }
        background(async () => {
          if (manifest.status === "source_review_required") await workflow.approveSource(dir);
          await workflow.translateProject(dir);
        });
        return send(202, { accepted: true });
      }
      if (action === "file" && req.method === "GET") {
        const kind = url.searchParams.get("kind");
        const format = url.searchParams.get("format");
        if (format) {
          if (kind !== "chinese" || !["pdf", "docx"].includes(format)) fail(400, "仅译文稿支持 PDF 或 Word 导出。");
          let markdown;
          try {
            const snapshot = await reviewSnapshot(dir);
            if (snapshot.model.units.some((unit) => !unit.artifact)) markdown = annotatedMarkdown(snapshot.model);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (!markdown) {
            const relative = manifest.outputs?.chinese;
            if (!relative) fail(404, "译文稿尚未生成。");
            markdown = await readFile(await projectFile(dir, relative), "utf8");
          }
          const filename = `${safeName(path.parse(path.basename(manifest.source.originalFile || id)).name)}-译文稿.${format}`;
          res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
          return send(200, format === "pdf" ? await exportPdf(markdown) : await exportWord(markdown),
            format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        }
        let relative = kind === "original" ? manifest.source.originalFile : kind === "source"
          ? manifest.source.normalizedFile || manifest.source.approvedFile || CANDIDATE : manifest.outputs?.[kind] || OUTPUTS[kind];
        const isDraft = manifest.draft?.files?.[kind] === relative;
        if (!isDraft && ["chinese", "bilingual", "bilingualHtml"].includes(kind)) {
          try {
            const snapshot = await reviewSnapshot(dir);
            if (snapshot.model.units.length) {
              if (url.searchParams.has("download")) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${kind === "bilingualHtml" ? "project_bilingual.html" : kind === "chinese" ? snapshot.model.languages?.targetLanguage === "en" ? "project_en.md" : "project_zh.md" : "project_bilingual.md"}`);
              const value = kind === "bilingualHtml" ? await renderReviewHtml(snapshot.model)
                : annotatedMarkdown(snapshot.model, { bilingual: kind === "bilingual" });
              if (kind === "bilingualHtml") reviewHtmlPolicy(res, value);
              return send(200, value, kind === "bilingualHtml" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
            }
            relative = snapshot.edits.outputs?.[kind] || relative;
          }
          catch (e) { if (e.code !== "ENOENT") throw e; }
        }
        if (!relative) fail(404, "文件尚未生成。");
        const file = await projectFile(dir, relative);
        const pdf = kind === "original" && path.extname(file).toLowerCase() === ".pdf";
        if (url.searchParams.has("download")) {
          res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
        }
        const value = await readFile(file);
        if (kind === "bilingualHtml") reviewHtmlPolicy(res, value);
        return send(200, value, pdf ? "application/pdf" : kind === "bilingualHtml" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
      }
      fail(405, "不支持此请求方式。");
    } catch (error) {
      if (!res.headersSent) send(error.status || (error.code === "ENOENT" ? 404 : 500), { error: error.code === "ENOENT" ? "文件尚未生成或不存在。" : error.message });
      else res.end();
    }
  });
  if (durable) {
    let recovering = false;
    const recover = async () => {
      if (recovering) return;
      recovering = true;
      try { await recoverTask(root); } catch (error) { if (error.code !== "TRANSLATION_BUSY") console.error(`后台恢复：${error.message}`); }
      finally { recovering = false; }
    };
    const timer = setInterval(recover, 5000); timer.unref();
    server.once("listening", recover);
    server.once("close", () => clearInterval(timer));
  }
  return server;
}

export async function startWebServer({ open = false, port = 4318 } = {}) {
  const server = createWebServer();
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || port >= 4418) throw error;
      port += 1;
    }
  }
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(`文献识别与翻译：${address}\n网页服务可关闭；已提交的后台任务独立运行，重开后可查看进度。`);
  if (open && process.platform === "win32") {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", address], { windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", () => console.log(`请在浏览器打开 ${address}`));
    child.unref();
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startWebServer({ open: process.argv.includes("--open") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
