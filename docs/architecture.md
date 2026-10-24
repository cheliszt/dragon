# 工作流设计说明

## 1. 已核实的外部接口事实

AI Studio PaddleOCR 异步 API：

- 提交地址：`POST https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`；
- 查询地址：`GET /api/v2/ocr/jobs/{jobId}`；
- 使用 `Authorization: Bearer {access_token}`；
- 本地上传与 `fileUrl` 二选一；
- 本地文件最大 50 MB，文件链接最大 200 MB，PDF 最多 1000 页；
- 完成后返回 `resultUrl.jsonUrl`；JSONL 每行的 `result.layoutParsingResults[].markdown.text` 保存页面 Markdown，`markdown.images` 和 `outputImages` 保存图片地址；
- 当前配置按用户提供的调用示例使用 `PaddleOCR-VL-1.6`；
- 若接口同时返回 `resultUrl.markdownUrl`，本工具仍优先使用 JSONL，以保留页面和图片信息。

来源：

- [AI Studio PaddleOCR 异步 API 文档](https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5)
- [AI Studio PaddleOCR MCP 文档](https://ai.baidu.com/ai-doc/AISTUDIO/bmfl1tnm4)
- 本仓库本次适配所依据的用户提供 API 调用示例。

GPT 侧使用 OpenAI Responses API 的 Structured Outputs，要求翻译和质检严格符合 JSON Schema。工具调用的官方闭环是：模型提出调用，应用执行外部工具，再将结果回传给模型。本项目的固定主流程不需要模型决定是否运行 OCR，因此由应用直接调用 AI Studio；动态局部重识别可在后续作为工具调用增加。

OpenAI 兼容端点可通过 `.env` 中的 `OPENAI_BASE_URL` 覆盖。示例 API 地址为
`https://api.openai.com/v1`，客户端会在其后追加 `/responses`。模型名必须使用该服务
实际开放的名称，并且服务端必须兼容 Responses API 与严格 JSON Schema 输出。

- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling#the-tool-calling-flow)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

## 2. 设计选择

### 主方案：REST API

```text
本地文件
  -> 调度器上传至 AI Studio
  -> 获得 jobId 并轮询
  -> 下载 Markdown/JSON
  -> 建立块 ID 与源文快照
  -> Responses API 分片翻译
  -> 确定性 QA + 独立语义 QA
  -> 双语稿与中文版
```

采用 REST API 的理由：

- 主流程固定，无需 GPT 自由决定是否 OCR；
- 异步任务 ID 便于恢复、审计和定位错误；
- 可以保存原始响应、模型名、源文哈希和结果地址；
- 不需要本地安装 PaddleOCR 模型或 Python OCR 依赖。

### 可选方案：PaddleOCR MCP

官方 MCP 客户端可以把推理源设置为 `aistudio`，因此计算仍在云端。不过客户端本身需要通过 `uvx` 运行 `paddleocr-mcp`。MCP 适合交互式应用临时调用 OCR；对长文批处理而言，状态控制与审计不如直接 REST 清楚，所以本项目不将 MCP 作为主链路。

## 3. 状态机

```text
ocr_submitting
  -> ocr_running
  -> source_review_required
  -> source_approved
  -> translating
  -> completed
```

异常状态：

- `ocr_failed`：上传、排队、解析或结果下载失败；
- `translation_failed`：GPT 请求、结构验证或文件生成失败；
- `qa_failed`：产物已经生成，但存在阻断问题，不应发布。

每次状态变化都会写入项目的 `manifest.json`。

### 后台执行与恢复

网页不再执行付费长请求。它将任务描述写入 `.runtime/task.json`，再启动隐藏的独立 Node 进程。进程以排他的本地监听套接字持有任务锁；另一网页实例或 CLI 不会并发翻译。任务状态为 `queued`、`running`、`retry_wait`、`paused`、`needs_attention` 或 `completed`。

网页重开时检查进程存活和任务锁，只有确认旧进程已退出才从断点启动；不会因一次状态查询超时重复启动。保存的恢复轮次跨进程保留，超过上限须人工继续。关闭网页进程不影响后台；电脑重启后需重新打开工作台。

每个完整响应通过结构和单元 ID 检查后写入按输入哈希定位的缓存。全部翻译完成后才进入独立质检阶段，质检失败不会清除翻译缓存。重试只重新请求未持久保存的步骤；失去响应但上游已完成的请求可能再次计费，本地缓存不提供跨服务的 exactly-once 保证。

HTTP 层负责安全 GET 的传输重试与每次请求的新截止时间；翻译任务层负责 Responses POST 的有限重试、限流退避和批次缩小；后台执行层在短期恢复耗尽后进行有限轮冷却恢复。缩小只发生在完整翻译单元之间。鉴权、账单及证书错误直接交给用户处理。

OCR 提交先保存提交意图，收到 jobId 后保存任务 ID；提交意图存在但没有 jobId 时不自动重传。恢复既有 OCR 任务只查询 jobId，下载采用原子发布并跳过完整已存文件。

## 4. 数据责任

| 数据 | 权威来源 | 是否允许覆盖 |
|---|---|---|
| 原始 PDF/图片 | 用户上传文件 | 否 |
| 原始 OCR Markdown/JSON | AI Studio 返回结果 | 否 |
| 校勘工作稿 | OCR 结果与人工核验 | 是 |
| 批准源文 | 人工批准快照 | 否；修改必须新建修订 |
| 双语稿 | 批准源文与 GPT 译文 | 可重新生成 |
| 中文版 | 双语稿中的中文 | 只能机械派生 |
| QA 报告 | 程序与独立 GPT 质检 | 可重新生成 |

## 5. 必要的人工环节

正式学术流程不应完全自动批准源文。以下情况需要人工判断：

- 原页与 OCR 文本冲突；
- 阅读顺序、边栏、跨页句或脚注归属不明确；
- 人名、作品名、术语存在多个合理译法；
- GPT 报告 `source_questions`；
- QA 报告存在 `blocking` 问题。

`--auto-approve` 只适合测试和低风险材料。

## 6. 仍需按项目补充的内容

1. 在 `config/glossary.md` 填写项目术语和禁用译法。
2. 在 `config/style-guide.md` 明确人名、引文、脚注、数字和专名规则。
3. 用一组包含正文、脚注、表格、图片和复杂版面的样本建立评测基线。
4. 确认材料发送给百度 AI Studio 和 OpenAI API 符合版权、保密与个人信息要求。
5. 超过 50 MB 的本地文件需要拆分，或者放到受控的 HTTPS 地址后使用 URL 模式；本工具不会擅自上传到第三方网盘。
6. 当前 OCR 原始 JSON 被完整保存，但不同模型的 JSON 字段存在差异。若需要精确到页面坐标的块级引用，应针对选定模型的 JSON Schema 增加映射器。

## 7. 两种自动化观点

一种方案让 GPT 统筹所有步骤并自由调用 OCR，灵活但较难保证没有跳过门禁。另一种方案用确定性程序固定每一步，可靠但例外处理较僵硬。本项目采用混合方案：程序控制状态、版本和验收门禁，GPT 负责翻译与语义判断；以后可将“获取原页”和“局部重识别”作为 GPT 工具增加。

