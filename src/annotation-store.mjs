import path from "node:path";
import { readJson, writeJson } from "./utils.mjs";
import { attachAnnotations } from "./annotations.mjs";

export const annotationDirectory = (dir, version) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(version)) throw new Error("无效读稿版本。");
  return path.join(dir, "08_annotations", version);
};
export async function readAnnotations(dir, model) {
  const folder = annotationDirectory(dir, model.version);
  let catalog;
  try { catalog = await readJson(path.join(folder, "catalog.json")); }
  catch (e) { if (e.code === "ENOENT") return { model }; throw e; }
  if (catalog.version !== model.version || catalog.sourceHash !== model.sourceHash) throw new Error("注释版本与当前读稿不匹配。");
  let changes;
  try { changes = await readJson(path.join(folder, "current.json")); }
  catch (e) { if (e.code !== "ENOENT") throw e; changes = { revision: 0, notes: {}, translatorNotes: [], history: [] }; }
  return { model: attachAnnotations(model, catalog, changes), catalog, changes, folder };
}

export async function saveAnnotationChanges(folder, changes) {
  await writeJson(path.join(folder, "history", `${String(changes.revision).padStart(6, "0")}.json`), changes);
  await writeJson(path.join(folder, "current.json"), changes);
}
