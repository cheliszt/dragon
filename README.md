# translator-dragon

面向文献阅读与人工校订的本地翻译工作台：PDF 文字提取或云端 PaddleOCR → 原文校对与批准 → 分段翻译 → 质检、修订与导出。GitHub 仓库名为 `dragon`，程序名称为 `translator-dragon`。

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
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.4
```

- `PADDLEOCR_ACCESS_TOKEN`：云端 OCR 使用的百度 AI Studio 访问令牌，见 [令牌管理](https://aistudio.baidu.com/account/accessToken)。仅使用本地 PDF 文字提取时无需填写。
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

## 密钥、隐私与仓库范围

本仓库仅包含程序源码、通用配置、测试和说明文档。上传副本已排除本机 `.env`、个人服务地址、既有翻译项目、项目专用修补脚本及对应测试、原始材料、译稿、缓存、诊断、日志和各阶段产物；不包含这些内容的历史 Git 提交。测试中的 `mock`、`dummy`、`secret` 等为模拟凭据。

**每位使用者都必须自行创建 `.env` 并填写自己的密钥。不要将 `.env`、令牌、密钥或含私人信息的项目文件提交到 GitHub。** `.gitignore` 已排除 `.env` 及其本地变体（保留空密钥示例 `.env.example`）、`projects/`、`diagnostics/`、`.runtime/`、`tmp/`、日志、依赖和常见凭据文件。添加文件前仍应人工检查；忽略规则不能阻止强制提交或清除既有 Git 历史。若密钥曾经泄露，删除文件不能代替在服务商处撤销或轮换密钥。

运行后会在本机生成 `projects/` 保存原始材料、校对稿、译文、质检与修订历史；`.runtime/` 保存任务状态；部分排查脚本会生成 `diagnostics/`。请按自己的需求备份这些本地资料，它们不会随源码上传。

数据去向以实际操作为准：本地文字提取不向 OCR 服务上传 PDF；云端 OCR 会向百度 AI Studio 发送原始材料；翻译、语义质检和 AI 修订会向 `.env` 配置的 API 服务发送相应文本。外部 API 可能收费，重试也可能产生额外用量。工作台仅监听本机地址，适用于个人本地使用。

## 验证

```powershell
npm test
```

测试使用本地模拟服务，不需要真实 API 密钥；通过测试不代表真实服务凭据、配额、模型权限或译文质量已验证。

本仓库公开可见，请勿上传密钥、私人材料或翻译项目数据。未附加开源许可证；公开可见不代表授予使用、修改或分发许可。第三方依赖适用各自的许可证。
