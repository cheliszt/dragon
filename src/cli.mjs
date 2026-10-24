#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { APP_ROOT, loadConfig } from "./config.mjs";
import { approveSource, runAll, runOcr, prepareSource, translateProject } from "./pipeline.mjs";
import { extractPdfText } from "./pdf-text.mjs";
import { errorMessage } from "./utils.mjs";
import { languageSettings } from "./languages.mjs";

const [command = "help", target, ...flags] = process.argv.slice(2);
const has = (name) => flags.includes(name);
const value = (name) => {
  const index = flags.indexOf(name);
  return index >= 0 ? flags[index + 1] : undefined;
};
const languages = () => has("--source-languages") || has("--target-language")
  ? languageSettings({ sourceLanguages: value("--source-languages")?.split(","), targetLanguage: value("--target-language") }) : undefined;

try {
  if (command === "doctor") {
    const config = await loadConfig();
    const checks = {
      node: process.version,
      paddleToken: Boolean(process.env.PADDLEOCR_ACCESS_TOKEN?.trim()),
      openaiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
      openaiModel: config.openai.model,
      openaiBaseUrl: config.openai.baseUrl,
      paddleModel: config.paddle.model,
      projectsDir: path.join(APP_ROOT, "projects")
    };
    console.log(JSON.stringify(checks, null, 2));
  } else if (command === "inspect") {
    requirePathTarget(target);
    const result = await extractPdfText(target, { pageRanges: value("--pages"), thresholds: (await loadConfig()).textLayer });
    const { pages, ...summary } = result.report;
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "prepare") {
    requireInputTarget(target);
    const result = await prepareSource(target, { mode: value("--mode") || "auto", languages: languages(), model: value("--model"), pageRanges: value("--pages") });
    printProject(result.projectDir, result.manifest.status);
    console.log(`源文来源：${result.manifest.preparation.method === "text" ? "本地文字提取" : "云端 OCR"}`);
  } else if (command === "ocr") {
    requireInputTarget(target);
    const result = await runOcr(target, { languages: languages(), model: value("--model"), pageRanges: value("--pages") });
    printProject(result.projectDir, result.manifest.status);
  } else if (command === "approve") {
    requirePathTarget(target);
    const manifest = await approveSource(target, { allowUnresolved: has("--allow-unresolved") });
    printProject(path.resolve(target), manifest.status);
  } else if (command === "translate") {
    requirePathTarget(target);
    const result = await translateProject(target, { languages: languages() });
    printProject(path.resolve(target), result.manifest.status);
  } else if (command === "run") {
    requireInputTarget(target);
    const result = await runAll(target, {
      autoApprove: has("--auto-approve"),
      languages: languages(),
      mode: value("--mode") || "auto",
      model: value("--model"),
      pageRanges: value("--pages")
    });
    printProject(result.projectDir, result.manifest.status);
  } else {
    console.log(`
PaddleOCR 云端解析 + GPT 翻译工作流

用法：
  node src/cli.mjs doctor
  node src/cli.mjs inspect <本地PDF> [--pages 1-5]
  node src/cli.mjs prepare <PDF、图片或URL> [--mode auto|text|ocr] [--pages 1-5]
  node src/cli.mjs ocr <PDF、图片或URL> [--model PaddleOCR-VL-1.6] [--pages 2,4-6]
  node src/cli.mjs approve <项目目录> [--allow-unresolved]
  node src/cli.mjs translate <项目目录>
  node src/cli.mjs run <PDF、图片或URL> [--mode auto|text|ocr] --auto-approve

推荐：先运行 prepare 自动选择提取方式，校对原文后再 approve 和 translate。ocr 始终强制调用云端。
prepare / ocr / run / translate 可添加 --source-languages en,zh-Hans,zh-Hant,ja,ko,pinyin 和 --target-language zh-Hans|en。
源语言可多选；已有目标语言及未选语种保留。选中文时包含汉语拼音，拼音译法须人工质检。
`);
  }
} catch (error) {
  console.error(`错误：${errorMessage(error)}`);
  process.exitCode = 1;
}

function requireInputTarget(targetPath) {
  if (!targetPath) throw new Error("缺少文件、URL 或项目目录参数。 ");
  if (isHttpUrl(targetPath)) return;
  if (!existsSync(path.resolve(targetPath))) throw new Error(`路径不存在：${targetPath}`);
}

function requirePathTarget(targetPath) {
  if (!targetPath) throw new Error("缺少文件或项目目录参数。 ");
  if (!existsSync(path.resolve(targetPath))) throw new Error(`路径不存在：${targetPath}`);
}

function printProject(projectDir, status) {
  console.log(`项目：${projectDir}`);
  console.log(`状态：${status}`);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
