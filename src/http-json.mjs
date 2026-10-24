import { sleep } from "./utils.mjs";
import { transientError, retryAfterMs } from "./reliability.mjs";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524]);

export async function requestJson(url, options, {
  fetchImpl = fetch, attempts = 4, label = "API", secret = "", sleepImpl = sleep, parseResponse,
  timeoutMs = 120000, onRetry = () => {}, retryNetwork = (options.method || "GET") === "GET"
} = {}) {
  const history = [];
  const redact = (value) => (secret ? String(value).split(secret).join("[REDACTED]") : String(value));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    let raw;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error("请求超时"), { code: "REQUEST_TIMEOUT" })), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      response = await fetchImpl(url, { ...options, signal });
      if (response.ok && parseResponse) return await parseResponse(response);
      raw = await response.text();
    } catch (cause) {
      clearTimeout(timer);
      if (cause.diagnostics) throw cause;
      const code = signal.aborted ? signal.reason?.code || "REQUEST_TIMEOUT" : cause.code || cause.cause?.code || (cause instanceof SyntaxError ? "INVALID_RESPONSE" : "NETWORK_ERROR");
      history.push({ attempt, networkError: redact(cause.message), code,
        detail: redact(cause.cause?.message || "") });
      const error = new Error(["EACCES", "EPERM"].includes(code)
        ? `${label} 网络连接被本机权限限制（${code}）；请在获准联网的环境中重新启动翻译服务后重试。`
        : `${label} 网络请求失败（${code}）；请检查网络连接后重试。${redact(cause.message)}`);
      error.diagnostics = { url, method: options.method || "GET", attempts: history };
      error.code = cause.name === "TimeoutError" ? "REQUEST_TIMEOUT" : code;
      error.status = cause.status;
      if (retryNetwork && !options.signal?.aborted && transientError(error) && attempt < attempts) {
        const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
        await onRetry({ attempt, delayMs: delay, code: error.code });
        await sleepImpl(delay);
        continue;
      }
      throw error;
    } finally { clearTimeout(timer); }
    const entry = {
      attempt, status: response.status,
      requestId: response.headers.get("x-request-id") || response.headers.get("request-id"),
      contentType: response.headers.get("content-type"),
      responseBody: redact(raw).slice(0, 16000)
    };
    history.push(entry);
    let data;
    try { data = JSON.parse(raw); } catch {}
    if (response.ok && data !== undefined) return data;
    const detail = data?.error?.message || data?.msg || data?.message || raw.slice(0, 500);
    const error = new Error(response.status === 524
      ? `${label} 请求失败：HTTP 524，中转站等待上游超时。已保存完成的分块，可继续重试。`
      : `${label} 请求失败：HTTP ${response.status}，${data === undefined ? "非 JSON 响应；" : ""}${redact(detail)}`);
    error.status = response.status;
    error.code = data?.error?.code;
    error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
    error.diagnostics = { url, method: options.method || "GET", attempts: history };
    if (!RETRYABLE.has(response.status) || !transientError(error) || attempt === attempts) throw error;
    const delay = Math.max(Math.min(30000, 1000 * 2 ** (attempt - 1)), error.retryAfterMs);
    await onRetry({ attempt, delayMs: delay, status: error.status, code: error.code });
    await sleepImpl(delay);
  }
}
