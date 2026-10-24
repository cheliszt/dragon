import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createWebServer } from "../src/web-server.mjs";
import { reviewCurrentDraft } from "../src/review-qa-jobs.mjs";
import { writeJson, writeText } from "../src/utils.mjs";
import { structureMarkdown } from "../src/markdown.mjs";
import { annotationDirectory } from "../src/annotation-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "review-editor-ui-")), dir = path.join(root, "projects/review-demo");
const units = Array.from({ length: 10 }, (_, i) => ({ id: `U${i}-0`, blockId: `U${i}`, page: i + 1, section: "正文", scope: "body",
  source: i === 0 ? "Blackness in this context. A coworker and coworkers." : `A coworker arrives. Another coworker leaves. Paragraph ${i + 1}.`,
  target: i === 0 ? "此处的黑人性。一个同事与几个同事。" : `一个同事来了。另一个同事走了。第 ${i + 1} 段。`,
  issueIds: i === 0 ? ["q1"] : [], sourceMarks: [], targetMarks: [] }));
const model = { version: "review-demo-v2", sourceHash: "demo", title: "全文编辑与术语检索测试", units,
  issues: [{ id: "q1", blockIds: ["U0"], severity: "warning", category: "术语", description: "核对 blackness 的语境。", recommendation: "首次标注原词。" }] };
await writeJson(path.join(dir, "04_qa/review-document.json"), model);
await writeJson(path.join(annotationDirectory(dir, model.version), "catalog.json"), { version: model.version, sourceHash: "demo", notes: [], references: [], unresolved: [], issues: [], paragraphMaps: {} });
await writeText(path.join(dir, "approved.md"), structureMarkdown("An example book.\n\nGLOSSARY OF CONCEPTS\n\ncoworker A social type with a special meaning at a rave.\n\nNOTES\n\nNo notes."));
await writeJson(path.join(dir, "manifest.json"), { projectId: "review-demo", status: "completed", createdAt: new Date().toISOString(),
  source: { approvedFile: "approved.md", approvedSha256: "demo" }, outputs: { chinese: "zh.md", bilingual: "bi.md", bilingualHtml: "reader.html", qa: "qa.md" }, reading: { version: model.version } });
await writeJson(path.join(root, "config/settings.json"), { openai: { chunkMaxChars: 3000 }, translation: { targetLanguage: "中文" } });
for (const file of ["workflow.md", "style-guide.md", "glossary.md"]) await writeText(path.join(dir, "00_shared", file), "Local fixture");
const client = { model: "fixture", baseUrl: "local", review: async () => ({ value: { issues: [] } }) };
const server = createWebServer({ root, workflow: {}, configLoader: async () => ({ openai: { model: "本地测试", baseUrl: "https://fixture.invalid" } }),
  reviewDraft: (dir, options) => reviewCurrentDraft(dir, { ...options, client }) });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ root, url: `http://127.0.0.1:${server.address().port}` }));
