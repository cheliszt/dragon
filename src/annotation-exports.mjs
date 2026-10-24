import path from "node:path";
import { annotatedMarkdown } from "./annotations.mjs";
import { annotationDirectory } from "./annotation-store.mjs";
import { renderReviewHtml } from "./reading-outputs.mjs";
import { writeText, writeJson, sha256 } from "./utils.mjs";

export async function publishAnnotationExports(dir, model) {
  const root = annotationDirectory(dir, model.version);
  const digest = sha256(JSON.stringify(model));
  const folder = path.join(root, "exports", digest);
  const chinese = annotatedMarkdown(model), bilingual = annotatedMarkdown(model, { bilingual: true });
  const html = await renderReviewHtml(model);
  await writeText(path.join(folder, "project_zh.md"), chinese);
  await writeText(path.join(folder, "project_bilingual.md"), bilingual);
  await writeText(path.join(folder, "project_bilingual.html"), html);
  const result = { version: model.version, annotationsRevision: model.annotations?.revision || 0,
    editRevision: model.editRevision || 0, digest, files: Object.fromEntries(["project_zh.md", "project_bilingual.md", "project_bilingual.html"].map((file) => [file, path.relative(dir, path.join(folder, file))])) };
  await writeJson(path.join(root, "exports-current.json"), result);
  return result;
}
