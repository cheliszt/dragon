const TRANSIENT_CODES = new Set(["REQUEST_TIMEOUT", "STREAM_IDLE_TIMEOUT", "STREAM_INTERRUPTED", "STREAM_FAILED", "CONCURRENCY_LIMIT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "NETWORK_ERROR"]);

export function transientError(error) {
  if (["PAUSED", "AUTHENTICATION_ERROR", "insufficient_quota", "billing_hard_limit_reached"].includes(error.code)) return false;
  if ([408, 429, 500, 502, 503, 504, 524].includes(error.status)) return true;
  return TRANSIENT_CODES.has(error.code || error.cause?.code);
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now || 0);
}

export function retryDelay(error, attempt, { baseMs = 2000, maxMs = 120000, random = Math.random } = {}) {
  const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.max(error.retryAfterMs || 0, Math.round(backoff * (0.8 + random() * 0.4)));
}

export function pausedError() {
  return Object.assign(new Error("任务已暂停；已完成的结果已保存。"), { code: "PAUSED" });
}
