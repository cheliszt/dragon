export async function readResponseStream(response, onProgress = () => {}, { idleTimeoutMs = 120000 } = {}) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed;
  let received = 0;
  const consume = async (frame) => {
    const payload = frame.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload);
    if (event.type === "response.output_text.delta") {
      received += event.delta?.length || 0;
      await onProgress({ receivedCharacters: received });
    }
    if (event.type === "response.completed") completed = event.response;
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      const error = new Error(`响应未完成：${event.response?.error?.message || event.error?.message || event.message || event.response?.incomplete_details?.reason || event.type}`);
      const upstreamCode = event.response?.error?.code || event.error?.code || event.code;
      error.code = ["insufficient_quota", "billing_hard_limit_reached", "invalid_api_key"].includes(upstreamCode) ? upstreamCode
        : /concurrency limit|rate.limit|too many requests/i.test(error.message)
        ? "CONCURRENCY_LIMIT" : event.type === "response.incomplete" ? "INCOMPLETE_RESPONSE" : "STREAM_FAILED";
      throw error;
    }
  };
  try {
    while (true) {
      let timer;
      const { done, value } = await Promise.race([reader.read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("流式响应长时间没有收到数据。"), { code: "STREAM_IDLE_TIMEOUT" })), idleTimeoutMs);
      })]).finally(() => clearTimeout(timer));
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await consume(frame);
      }
      if (completed) return completed;
      if (done) break;
    }
    if (buffer.trim()) await consume(buffer);
    if (completed) return completed;
    throw Object.assign(new Error("流式连接中断，未收到完成事件；部分文本不会作为完整译文保存。"), { code: "STREAM_INTERRUPTED" });
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
