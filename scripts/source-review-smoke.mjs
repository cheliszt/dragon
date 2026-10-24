// Browser verification on a disposable copy; never approves or translates the real project.
import { copyFile, mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWebServer } from "../src/web-server.mjs";
import { approveSource } from "../src/pipeline.mjs";
import { readJson, writeJson } from "../src/utils.mjs";

if (!process.argv[2]) throw new Error("Usage: node scripts/source-review-smoke.mjs <project-directory>");
const project = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(os.tmpdir(), "source-review-ui-"));
const dir = path.join(root, "projects/source-review-demo");
const original = await readJson(path.join(project, "manifest.json"));
const source = { candidateFile: "02_source_candidates/reconciled/document.md", originalFile: "original.pdf" };
for (const [from, to] of [[original.source.candidateFile, source.candidateFile], [original.source.originalFile, source.originalFile]]) {
  await mkdir(path.dirname(path.join(dir, to)), { recursive: true });
  await copyFile(path.resolve(project, from), path.join(dir, to));
}
await writeJson(path.join(dir, "manifest.json"), { projectId: "source-review-demo", createdAt: new Date().toISOString(), status: "source_review_required", source });
process.env.OPENAI_API_KEY = "local-fixture-only";
const server = createWebServer({ root,
  configLoader: async () => ({ openai: { model: "本地界面测试（不调用 API）", baseUrl: "https://fixture.invalid" } }),
  workflow: { approveSource, async translateProject(projectDir) {
    const manifest = await readJson(path.join(projectDir, "manifest.json"));
    manifest.status = "completed";
    await writeJson(path.join(projectDir, "manifest.json"), manifest);
  } }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ root, url: `http://127.0.0.1:${server.address().port}` }));
