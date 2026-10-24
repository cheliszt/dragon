import { readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { APP_ROOT, loadConfig, requireSecret } from "../src/config.mjs";
import { extractPdfText, openPdf } from "../src/pdf-text.mjs";
import { PaddleCloudClient, fileMimeType } from "../src/paddle-client.mjs";
import { OpenAIClient } from "../src/openai-client.mjs";
import { ensureDir, writeJson, sha256File, timestampId } from "../src/utils.mjs";

const [command, ...args] = process.argv.slice(2);
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const directory = path.join(APP_ROOT, "diagnostics", `${timestampId()}-${randomUUID().slice(0, 8)}`);

async function prepare(file) {
  const input = path.resolve(file);
  const extracted = await extractPdfText(input);
  const pageNumber = Number(option("--page") || extracted.report.pages.find((p) => p.usable)?.page || 1);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > extracted.report.totalPages) throw new Error("实验页码超出 PDF 范围。");
  await ensureDir(directory);
  await copyFile(input, path.join(directory, "original.pdf"));
  const original = await PDFDocument.load(await readFile(input));
  const sample = await PDFDocument.create();
  const [page] = await sample.copyPages(original, [pageNumber - 1]);
  sample.addPage(page);
  await writeFile(path.join(directory, "sample.pdf"), await sample.save({ useObjectStreams: false }));
  const normalized = await PDFDocument.create();
  for (const copied of await normalized.copyPages(original, original.getPageIndices())) normalized.addPage(copied);
  await writeFile(path.join(directory, "normalized.pdf"), await normalized.save({ useObjectStreams: false }));
  const control = await PDFDocument.create();
  const font = await control.embedFont(StandardFonts.Helvetica);
  control.addPage([500, 700]).drawText("A short document for an OCR diagnostic test.\nLiterature and translation.", { x: 40, y: 620, size: 16, font });
  await writeFile(path.join(directory, "control.pdf"), await control.save({ useObjectStreams: false }));
  const task = await openPdf(input);
  try {
    const document = await task.promise;
    const pdfPage = await document.getPage(pageNumber);
    const viewport = pdfPage.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    await writeFile(path.join(directory, "sample.png"), canvas.toBuffer("image/png"));
  } finally { await task.destroy(); }
  await writeJson(path.join(directory, "text-layer.json"), extracted.report);
  const files = {};
  for (const name of ["original.pdf", "normalized.pdf", "sample.pdf", "sample.png", "control.pdf"]) {
    files[name] = { path: path.join(directory, name), sha256: await sha256File(path.join(directory, name)) };
  }
  await writeJson(path.join(directory, "inputs.json"), { originalPath: input, pdfPage: pageNumber, files });
  console.log(`实验样本已生成（PDF 第 ${pageNumber} 页）：${directory}\n未调用任何外部 API。`);
}

async function probe() {
  const config = await loadConfig();
  await ensureDir(directory);
  let context;
  try {
    if (command === "probe-ocr") {
      const file = path.resolve(args[0]);
      const mimeType = option("--mime") || fileMimeType(file);
      const uploadName = fileMimeType(file) === "application/pdf" ? "document.pdf" : "document.png";
      context = { provider: "paddle", file, sha256: await sha256File(file), mimeType, uploadName, model: config.paddle.model, optionalPayload: config.paddle.optionalPayload };
      const client = new PaddleCloudClient({ token: requireSecret("PADDLEOCR_ACCESS_TOKEN"), baseUrl: config.paddle.baseUrl, attempts: 1 });
      const submitted = await client.submitFile(file, { model: config.paddle.model, optionalPayload: config.paddle.optionalPayload, mimeType, uploadName });
      await writeJson(path.join(directory, "result.json"), { ...context, phase: "accepted", submitted });
      console.log(`已受理，jobId：${submitted.data.jobId}`);
      if (args.includes("--wait")) {
        const completed = await client.waitForJob(submitted.data.jobId, (progress) => writeJson(path.join(directory, "progress.json"), progress));
        await writeJson(path.join(directory, "result.json"), { ...context, phase: "completed", submitted, completed });
        console.log("OCR 任务完成。");
      }
    } else {
      context = { provider: "translation", model: config.openai.model, baseUrl: config.openai.baseUrl };
      const client = new OpenAIClient({ apiKey: requireSecret("OPENAI_API_KEY"), ...config.openai });
      const result = await client.translate([{ block_id: "B000001", source: "This is a short translation test." }], { targetLanguage: "简体中文", workflow: "Translate faithfully.", styleGuide: "Use clear Chinese.", glossary: "" });
      if (result.value.translations?.length !== 1 || result.value.translations[0].block_id !== "B000001" || !result.value.translations[0].translation?.trim()) throw new Error("返回结果未满足项目的翻译结构要求。");
      await writeJson(path.join(directory, "result.json"), { ...context, phase: "completed", result });
      console.log("Responses API 结构化翻译测试通过。");
    }
  } catch (error) {
    await writeJson(path.join(directory, "error.json"), { ...context, error: error.message, diagnostics: error.diagnostics });
    throw error;
  } finally { console.log(`实验记录：${directory}`); }
}

try {
  if (command === "prepare" && args[0]) await prepare(args[0]);
  else if (command === "probe-ocr" && args[0] || command === "probe-translation") await probe();
  else console.log("本地生成：node scripts/diagnose.mjs prepare <PDF> [--page 29]\n实际调用 OCR：node scripts/diagnose.mjs probe-ocr <文件> [--mime application/pdf] [--wait]\n实际调用翻译：node scripts/diagnose.mjs probe-translation\nprobe 命令会调用已配置的服务并可能消耗额度；prepare 只在本地生成副本。");
} catch (error) { console.error(error.message); process.exitCode = 1; }
