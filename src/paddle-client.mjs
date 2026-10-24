import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeText, fileSize, sleep } from "./utils.mjs";
import { requestJson } from "./http-json.mjs";

const LOCAL_UPLOAD_LIMIT = 50 * 1024 * 1024;

export class PaddleCloudClient {
  constructor({ token, baseUrl, pollIntervalMs = 5000, timeoutMs = 3600000, fetchImpl = fetch, sleepImpl = sleep, attempts = 4, onRetry = () => {}, checkpoint = () => {} }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.attempts = attempts;
    this.onRetry = onRetry;
    this.checkpoint = checkpoint;
  }

  get jobsUrl() {
    return `${this.baseUrl}/api/v2/ocr/jobs`;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, "Accept-Encoding": "gzip, deflate, br" };
  }

  async submitFile(filePath, { model, optionalPayload = {}, pageRanges, batchId, mimeType, uploadName } = {}) {
    const size = await fileSize(filePath);
    if (size > LOCAL_UPLOAD_LIMIT) {
      throw new Error("AI Studio 本地文件上传上限为 50 MB；请拆分文件，或改用可访问的 HTTPS 文件链接。 ");
    }

    const form = new FormData();
    form.append("file", new Blob([await readFile(filePath)], { type: mimeType || fileMimeType(filePath) }), uploadName || path.basename(filePath));
    form.append("model", model);
    form.append("optionalPayload", JSON.stringify(optionalPayload));
    if (pageRanges) form.append("pageRanges", pageRanges);
    if (batchId) form.append("batchId", batchId);

    const response = await this.request(this.jobsUrl, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    const jobId = response?.data?.jobId;
    if (!jobId) throw new Error(`AI Studio 未返回 jobId：${JSON.stringify(response)}`);
    return response;
  }

  async submitUrl(fileUrl, { model, optionalPayload = {}, pageRanges, batchId } = {}) {
    const payload = {
      fileUrl,
      model,
      optionalPayload
    };
    if (pageRanges) payload.pageRanges = pageRanges;
    if (batchId) payload.batchId = batchId;

    const response = await this.request(this.jobsUrl, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const jobId = response?.data?.jobId;
    if (!jobId) throw new Error(`AI Studio 未返回 jobId：${JSON.stringify(response)}`);
    return response;
  }

  async getJob(jobId) {
    return this.request(`${this.jobsUrl}/${encodeURIComponent(jobId)}`, {
      headers: { ...this.headers(), "Content-Type": "application/json" },
    });
  }

  async waitForJob(jobId, onProgress = () => {}) {
    const started = Date.now();
    while (Date.now() - started < this.timeoutMs) {
      await this.checkpoint();
      const response = await this.getJob(jobId);
      const data = response?.data || {};
      await onProgress(response);
      if (data.state === "done") return response;
      if (data.state === "failed") {
        throw new Error(`AI Studio 解析失败：${data.errorMsg || "未知原因"}`);
      }
      if (!['pending', 'running'].includes(data.state)) {
        throw new Error(`AI Studio 返回未知任务状态：${data.state || "空"}`);
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw Object.assign(new Error(`AI Studio 任务等待超过 ${Math.round(this.timeoutMs / 60000)} 分钟；可按现有 jobId 继续查询。`), { code: "REQUEST_TIMEOUT" });
  }

  async download(resultUrl, targetPath) {
    await this.checkpoint();
    try { if (await fileSize(targetPath) > 0) return; } catch {}
    const url = new URL(resultUrl);
    if (url.protocol !== "https:") throw new Error("拒绝下载非 HTTPS 的 OCR 结果地址。 ");
    const content = await requestJson(url, { headers: { "Accept-Encoding": "gzip, deflate, br" } }, {
      fetchImpl: this.fetch, attempts: this.attempts, sleepImpl: this.sleep, onRetry: this.onRetry,
      label: "OCR 下载", parseResponse: async (response) => Buffer.from(await response.arrayBuffer())
    });
    await writeText(targetPath, content);
  }

  async request(url, options, attempts = this.attempts) {
    const data = await requestJson(url, options, {
      fetchImpl: this.fetch, attempts: options.method === "POST" ? 1 : attempts,
      label: "AI Studio", secret: this.token, sleepImpl: this.sleep, onRetry: this.onRetry
    });
    if (data.code !== 0 && data.code !== undefined) {
      const error = new Error(`AI Studio 业务错误：${data.msg || data.message || data.code}`);
      error.diagnostics = { url, response: data };
      throw error;
    }
    return data;
  }
}

export function fileMimeType(filePath) {
  return ({ ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp", ".webp": "image/webp" })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function parsePaddleOcrJsonl(jsonlText) {
  const markdownPages = [];
  const markdownImages = [];
  const outputImages = [];

  for (const [lineIndex, rawLine] of jsonlText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`OCR JSONL 第 ${lineIndex + 1} 行不是有效 JSON：${error.message}`);
    }

    const results = parsed?.result?.layoutParsingResults;
    if (!Array.isArray(results)) {
      throw new Error(`OCR JSONL 第 ${lineIndex + 1} 行缺少 result.layoutParsingResults。`);
    }

    for (const [resultIndex, result] of results.entries()) {
      const text = result?.markdown?.text;
      if (typeof text === "string" && text.trim()) {
        const pageIndex = Number.isInteger(result.page_index) && result.page_index >= 0 ? result.page_index + 1 : markdownPages.length + 1;
        markdownPages.push(`<!-- pdf_page: ${pageIndex} -->\n\n${text.trimEnd()}`);
      }

      for (const [relativePath, url] of Object.entries(result?.markdown?.images || {})) {
        if (typeof url === "string" && url) {
          markdownImages.push({ relativePath, url, lineIndex, resultIndex });
        }
      }

      for (const [name, url] of Object.entries(result?.outputImages || {})) {
        if (typeof url === "string" && url) {
          outputImages.push({ name, url, lineIndex, resultIndex });
        }
      }
    }
  }

  if (!markdownPages.length) {
    throw new Error("OCR JSONL 中没有可用的 markdown.text。");
  }

  return {
    markdown: `${markdownPages.join("\n\n").trimEnd()}\n`,
    markdownImages,
    outputImages
  };
}
