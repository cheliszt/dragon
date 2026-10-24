import path from "node:path";
import { reviewSnapshot } from "../src/review-edits.mjs";
import { prepareAnnotations } from "../src/annotation-jobs.mjs";
import { withTranslationLock } from "../src/translation-lock.mjs";
import { writeJson, sha256 } from "../src/utils.mjs";
import { annotationDirectory } from "../src/annotation-store.mjs";
import { publishAnnotationExports } from "../src/annotation-exports.mjs";

if (!process.argv[2]) throw new Error("用法：node scripts/prepare-annotations.mjs <项目目录>");
const dir = path.resolve(process.argv[2]);
await withTranslationLock(dir, async () => {
  const snapshot = await reviewSnapshot(dir);
  await writeJson(path.join(annotationDirectory(dir, snapshot.model.version), "body-before.json"), {
    version: snapshot.model.version, editRevision: snapshot.edits.revision,
    targets: snapshot.model.units.map((u) => ({ id: u.id, hash: sha256(u.target || "") }))
  });
  const catalog = await prepareAnnotations(dir, snapshot.model, { onProgress: (event) => console.log(JSON.stringify(event)) });
  await publishAnnotationExports(dir, (await reviewSnapshot(dir)).model);
  console.log(JSON.stringify({ notes: catalog.notes.length, references: catalog.references.length, unresolved: catalog.unresolved.length, completed: catalog.completedAt }));
}, { details: { name: "翻译原注与恢复段后注释" } });
