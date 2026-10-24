import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { taskFile, pauseFile } from "./task-manager.mjs";
import { withTranslationLock } from "./translation-lock.mjs";
import { loadConfig } from "./config.mjs";
import { prepareSource, resumePreparation, translateProject } from "./pipeline.mjs";
import { readJson, writeJson, sleep } from "./utils.mjs";
import { transientError, pausedError } from "./reliability.mjs";
import { prepareAnnotations } from "./annotation-jobs.mjs";
import { reviewSnapshot } from "./review-edits.mjs";
import { publishAnnotationExports } from "./annotation-exports.mjs";
import { reviewCurrentDraft } from "./review-qa-jobs.mjs";

export async function runTask(root, id) {
  const task = await readJson(taskFile(root));
  if (task.id !== id || !["queued", "running", "retry_wait"].includes(task.state)) return;
  if (!task.projectId || /[\\/:]/.test(task.projectId) || [".", ".."].includes(task.projectId)) throw new Error("无效项目编号。");
  const directory = path.join(root, "projects", task.projectId);
  const config = await loadConfig(root);
  const maximum = config.recovery?.maxCycles || 3;
  const save = async () => { task.updatedAt = new Date().toISOString(); await writeJson(taskFile(root), task); };
  const checkpoint = async () => {
    try { await access(pauseFile(root, id)); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    throw pausedError();
  };
  const wait = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { await checkpoint(); await sleep(Math.min(1000, end - Date.now())); }
  };
  try {
    await withTranslationLock(directory, async () => {
      task.pid = process.pid;
      for (; task.cycle < maximum;) {
        try {
          await checkpoint();
          if (task.nextRetryAt) await wait(Math.max(0, Date.parse(task.nextRetryAt) - Date.now()));
          task.cycle++; task.state = "running"; delete task.nextRetryAt; delete task.error;
          await save();
          const options = { root, lockHeld: true, checkpoint, sleepImpl: wait };
          let manifest;
          try { manifest = await readJson(path.join(directory, "manifest.json")); } catch (e) { if (e.code !== "ENOENT") throw e; }
          const savedRetry = task.type === "translation" ? manifest?.openai?.request : manifest?.preparation?.retry;
          if (savedRetry?.nextRetryAt) await wait(Math.max(0, Date.parse(savedRetry.nextRetryAt) - Date.now()));
          if (task.type === "translation") {
            if (!manifest) throw new Error("项目不存在。");
            // A crash after final output publication must not restart a finished run.
            if (!["completed", "qa_failed"].includes(manifest.status) || !manifest.completedAt || manifest.completedAt < task.createdAt) await translateProject(directory, options);
          } else if (task.type === "review") {
            await reviewCurrentDraft(directory, { ...options, runId: task.id, mode: task.mode, unitIds: task.unitIds,
              onProgress: async (progress) => { task.progress = progress; await save(); } });
          } else if (task.type === "annotations") {
            const snapshot = await reviewSnapshot(directory);
            await prepareAnnotations(directory, snapshot.model, { ...options, onProgress: async (progress) => { task.progress = progress; await save(); } });
            await publishAnnotationExports(directory, (await reviewSnapshot(directory)).model);
          } else if (task.type === "preparation") {
            if (manifest) await resumePreparation(directory, options);
            else await prepareSource(task.sourceFile, { ...options, mode: task.mode, languages: task.languages, projectId: task.projectId, projectsDir: path.join(root, "projects") });
          } else throw new Error("未知后台任务类型。");
          task.state = "completed"; await save(); return;
        } catch (error) {
          if (error.code === "PAUSED") throw error;
          task.error = error.message; task.code = error.code;
          if (!transientError(error) || task.cycle >= maximum) throw error;
          const delay = Math.max(error.retryAfterMs || 0, (config.recovery?.cooldownMs ?? 60000) * task.cycle);
          task.state = "retry_wait"; task.nextRetryAt = new Date(Date.now() + delay).toISOString(); await save();
        }
      }
      throw new Error("自动恢复次数已用尽，结果已保存，可稍后继续。");
    }, { root: task.type === "review" ? path.join(root, ".runtime/review-qa") : root,
      details: { taskId: id, name: task.type === "review" ? "质检当前修订稿" : task.type === "translation" ? "翻译与质检" : task.type === "annotations" ? "整理段后注释" : "获取原文" } });
  } catch (error) {
    task.state = error.code === "PAUSED" ? "paused" : "needs_attention";
    task.error = error.message; task.code = error.code; delete task.nextRetryAt;
    await save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTask(path.resolve(process.argv[2]), process.argv[3]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
