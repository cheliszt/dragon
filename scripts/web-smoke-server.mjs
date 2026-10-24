// Local browser-test fixture. No external API requests or user credentials.
import { mkdtemp, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWebServer } from "../src/web-server.mjs";
import { approveSource } from "../src/pipeline.mjs";
import { readJson, writeJson, writeText, sleep } from "../src/utils.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "translation-browser-test-"));
const sourceFile = "02_source_candidates/reconciled/document.md";
const stream = "BT /F1 18 Tf 60 730 Td (Literature and translation) Tj 0 -36 Td /F1 12 Tf (A local test document. No external API is called.) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const sample = path.join(root, "sample.pdf");
await writeFile(sample, pdf);
process.env.PADDLEOCR_ACCESS_TOKEN = "fixture-only";
process.env.OPENAI_API_KEY = "fixture-only";
const server = createWebServer({
  root,
  configLoader: async () => ({ openai: { model: "本地测试模型", baseUrl: "https://fixture.invalid/v1" } }),
  workflow: {
    async prepareSource(file, { onProjectCreated, languages }) {
      const id = `${Date.now()}-sample`;
      const dir = path.join(root, "projects", id);
      const original = "01_source_original/sample.pdf";
      await mkdir(path.dirname(path.join(dir, original)), { recursive: true });
      await copyFile(file, path.join(dir, original));
      const manifest = { projectId: id, languages, status: "ocr_running", createdAt: new Date().toISOString(), source: { originalFile: original }, paddle: { progress: { totalPages: 1, extractedPages: 0 } } };
      await writeJson(path.join(dir, "manifest.json"), manifest);
      await onProjectCreated(dir);
      await sleep(1500);
      await writeText(path.join(dir, sourceFile), "<!-- block_id: B000001 -->\n\n# Literature and translation\n\n<!-- block_id: B000002 -->\n\nA local test document. No external API is called.\n");
      manifest.status = "source_review_required";
      manifest.source.candidateFile = sourceFile;
      await writeJson(path.join(dir, "manifest.json"), manifest);
    },
    approveSource,
    async translateProject(dir) {
      const manifest = await readJson(path.join(dir, "manifest.json"));
      manifest.status = "translating";
      manifest.openai = { completedChunks: 0, chunkCount: 1 };
      await writeJson(path.join(dir, "manifest.json"), manifest);
      await sleep(1500);
      await writeText(path.join(dir, "05_bilingual/project_bilingual.md"), "# Literature and translation\n\n# 文学与翻译\n\nA local test document.\n\n本地测试文献。\n");
      await writeText(path.join(dir, "06_zh/project_zh.md"), "# 文学与翻译\n\n本地测试文献。\n");
      await writeText(path.join(dir, "04_qa/final.md"), "# 质检报告\n\n本地模拟结果：通过。\n");
      manifest.status = "completed";
      manifest.outputs = { chinese: "06_zh/project_zh.md", bilingual: "05_bilingual/project_bilingual.md", qa: "04_qa/final.md" };
      await writeJson(path.join(dir, "manifest.json"), manifest);
    }
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, sample, root }));
