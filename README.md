# translator-dragon

面向文献阅读与人工校订的本地AI翻译工作台：PDF 文字提取或云端 PaddleOCR → 原文校对与批准 → 分段翻译 → 质检、修订与导出。
支持双语审阅、术语管理、原注与译注、断点恢复，以及 Markdown、HTML、Word、PDF 导出。AI 生成的译文、术语判断和质检建议仍须对照原文人工核查。

## 安装与启动

需要 Node.js **22.13.0 或更新版本**及 npm。克隆后执行：

```powershell
git clone https://github.com/cheliszt/dragon.git
cd dragon
npm ci
Copy-Item .env.example .env
```

用文本编辑器打开 `.env`，按自己的账户配置：

```dotenv
PADDLEOCR_ACCESS_TOKEN=
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
```

- `PADDLEOCR_ACCESS_TOKEN`：云端 OCR 使用的访问令牌.仅使用本地 PDF 文字提取时无需填写。
- `OPENAI_API_KEY`：翻译、语义质检和 AI 修订所需的服务密钥。
- `OPENAI_BASE_URL`：默认使用 OpenAI 官方地址。也可配置兼容服务，但必须支持 Responses API 和严格 JSON Schema 输出；程序会追加 `/responses`。
- `OPENAI_MODEL`：填写账户实际可用且支持上述接口的模型名，示例名称不保证对所有账户可用。

```powershell
npm run doctor
npm start
```

Windows 也可双击 `start-web.cmd`。默认打开 `http://127.0.0.1:4318`，端口占用时使用后续端口，以启动输出为准。修改 `.env` 后须重启服务。

## 使用流程

1. 选择 PDF，选择自动判断、本地文字提取或云端 OCR，并设置源语言、目标语言。
2. 对照 PDF 校对原文，处理待核标记，再保存并批准原文。
3. 启动翻译，查看进度、双语稿及质检问题；暂停后可继续已保存的任务。
4. 人工核查、修订译文，再从网页下载当前版本。

详细操作、命令行用法及恢复机制见 [使用手册](docs/usage.md)；实现说明及接口来源见 [架构说明](docs/architecture.md)。通用翻译规则可在 `config/workflow.md`、`config/style-guide.md`、`config/glossary.md` 中调整。
