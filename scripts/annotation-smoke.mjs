import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createWebServer } from "../src/web-server.mjs";
import { buildAnnotations } from "../src/annotations.mjs";
import { annotationDirectory } from "../src/annotation-store.mjs";
import { writeJson, writeText } from "../src/utils.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "annotation-ui-"));
const dir = path.join(root, "projects/annotation-demo");
const source = "First thought.1 Next paragraph.2";
const target = "第一段已经人工修订。第二段也已经修订。";
const model = { version: "annotation-demo-v1", sourceHash: "demo", title: "段后注释测试", issues: [], units: [
  { id: "u1", blockId: "U000001", source, target, section: "正文", scope: "body", issueIds: [], sourceMarks: [], targetMarks: [] }
] };
const approved = `${source}\n\nNOTES\n\n1 Author explanation of the first thought.\n2 Another author explanation.`;
const catalog = buildAnnotations(approved, model);
catalog.notes[0].translation = "第一段的作者原注译文。";
catalog.notes[1].translation = "第二段的作者原注译文。";
catalog.references[0].targetQuote = "第一段已经人工修订。";
catalog.references[1].targetQuote = "第二段也已经修订。";
const cut = source.indexOf(" Next");
catalog.paragraphMaps.u1 = { paragraphs: [
  { id: "p1", sourceStart: 0, sourceEnd: cut, targetQuote: "第一段已经人工修订。" },
  { id: "p2", sourceStart: cut, sourceEnd: source.length, targetQuote: "第二段也已经修订。" }
] };
await writeJson(path.join(dir, "04_qa/review-document.json"), model);
await writeJson(path.join(annotationDirectory(dir, model.version), "catalog.json"), catalog);
await writeText(path.join(dir, "approved.md"), approved);
await writeJson(path.join(dir, "manifest.json"), { projectId: "annotation-demo", status: "completed", createdAt: new Date().toISOString(),
  source: { approvedSha256: "demo", approvedFile: "approved.md" }, reading: { version: model.version }, outputs: { chinese: "06_zh/project_zh.md", bilingual: "05_bilingual/project_bilingual.md", bilingualHtml: "05_bilingual/project_bilingual.html" } });
const server = createWebServer({ root, workflow: {}, configLoader: async () => ({ openai: { model: "本地测试", baseUrl: "https://fixture.invalid/v1" } }) });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ root, url: `http://127.0.0.1:${server.address().port}` }));
