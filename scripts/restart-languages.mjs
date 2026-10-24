// Explicit, recoverable restart of a stopped project after the user changes its languages.
import path from "node:path";
import { cp, readdir, stat } from "node:fs/promises";
import { APP_ROOT } from "../src/config.mjs";
import { readJson, writeJson, sha256File, timestampId } from "../src/utils.mjs";
import { languageSettings } from "../src/languages.mjs";
import { withTranslationLock } from "../src/translation-lock.mjs";
import { taskState, startTask } from "../src/task-manager.mjs";

const [requested, sources, target = "zh-Hans"] = process.argv.slice(2);
if (!requested || !sources) throw new Error("用法：node scripts/restart-languages.mjs <项目目录> en,zh-Hans,pinyin zh-Hans");
const dir = path.resolve(requested), root = APP_ROOT;
if (path.dirname(dir) !== path.join(root, "projects")) throw new Error("仅允许重启当前工作区 projects 下的单个项目。");
const languages = languageSettings({ sourceLanguages: sources.split(","), targetLanguage: target });
let archive;
await withTranslationLock(dir, async () => {
  const task = await taskState(root);
  if (task?.workerAlive || task?.active || ["queued", "running", "retry_wait"].includes(task?.state)) throw new Error("后台任务仍存活或待恢复，请先安全暂停再重启。");
  const manifest = await readJson(path.join(dir, "manifest.json"));
  if (manifest.projectId !== path.basename(dir) || !manifest.source.approvedFile) throw new Error("项目身份或批准原文缺失。");
  const sourcePath = path.resolve(dir, manifest.source.approvedFile);
  if (!sourcePath.startsWith(dir + path.sep)) throw new Error("原文路径超出当前项目。");
  const originalHash = await sha256File(sourcePath);
  if (originalHash !== manifest.source.approvedSha256) throw new Error("批准源文已改变，拒绝重启。");
  archive = path.join(dir, "09_history", `${timestampId()}-before-language-restart`);
  const hashes = {};
  async function list(folder, relative = "") {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const name = path.join(relative, item.name), full = path.join(folder, item.name);
      if (item.isDirectory()) await list(full, name);
      else if (item.isFile()) hashes[name] = await sha256File(full);
    }
  }
  for (const name of ["manifest.json", "00_shared", "04_qa", "05_bilingual", "06_zh", "07_revisions", "08_annotations"]) {
    const from = path.join(dir, name);
    try { await stat(from); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    await cp(from, path.join(archive, name), { recursive: true, force: false, errorOnExist: true });
    const info = await stat(from);
    if (info.isDirectory()) await list(from, name); else hashes[name] = await sha256File(from);
  }
  for (const [name, hash] of Object.entries(hashes)) if (await sha256File(path.join(archive, name)) !== hash) throw new Error(`归档校验失败：${name}`);
  await writeJson(path.join(archive, "restart-audit.json"), { createdAt: new Date().toISOString(), reason: "用户要求重新检测英语、简体中文及汉语拼音并完整重译", languages,
    previousTask: task, approvedSha256: originalHash, files: hashes });
  manifest.languageRestarts = [...(manifest.languageRestarts || []), { at: new Date().toISOString(), archive: path.relative(dir, archive), previousLanguages: manifest.languages || { sourceLanguages: ["en"], targetLanguage: "zh-Hans" }, languages }];
  for (const key of ["openai", "outputs", "reading", "completedAt", "error", "errorDetails", "annotationProgress", "sharedInputs"]) delete manifest[key];
  manifest.languages = languages;
  manifest.status = "source_approved";
  manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(dir, "manifest.json"), manifest);
  if (await sha256File(sourcePath) !== originalHash) throw new Error("批准源文发生异常变化。");
}, { root, details: { name: "归档旧翻译并重设语言" } });
const task = await startTask(root, { type: "translation", projectId: path.basename(dir), languages });
console.log(JSON.stringify({ archive, taskId: task.id, pid: task.pid, languages }));
