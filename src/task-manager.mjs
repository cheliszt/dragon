import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { open, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, ensureDir } from "./utils.mjs";
import { translationOwner, withTranslationLock } from "./translation-lock.mjs";

const pending = new Set(["queued", "running", "retry_wait"]);
export const taskFile = (root) => path.join(root, ".runtime/task.json");
export const pauseFile = (root, id) => path.join(root, ".runtime", `${id}.pause.json`);
const launchFile = (root) => path.join(root, ".runtime/launch.json");
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const optionalJson = async (file) => { try { return await readJson(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };

export async function taskState(root) {
  const task = await optionalJson(taskFile(root));
  if (!task) return null;
  const launch = await optionalJson(launchFile(root));
  const pid = launch?.id === task.id ? launch.pid : task.pid;
  const workerAlive = alive(pid);
  let pauseRequested = false;
  try { await access(pauseFile(root, task.id)); pauseRequested = true; } catch {}
  return { ...task, pid, workerAlive, pauseRequested, active: pending.has(task.state) && (workerAlive || task.state === "queued") };
}

async function launch(root, task) {
  const log = await open(path.join(root, ".runtime/worker.log"), "a");
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./task-worker.mjs", import.meta.url)), root, task.id], {
      cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd]
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await writeJson(launchFile(root), { id: task.id, pid: child.pid, launchedAt: new Date().toISOString() });
    child.unref();
    return { ...task, pid: child.pid };
  } finally { await log.close(); }
}

const dispatch = (root, operation) => withTranslationLock("task-dispatch", operation, { root: path.join(root, ".runtime/dispatch") });

export async function startTask(root, { type, projectId, sourceFile, mode, unitIds, languages }) {
  return dispatch(root, async () => {
    if (await translationOwner(root)) throw Object.assign(new Error("已有后台任务正在运行。"), { status: 409 });
    const previous = await taskState(root);
    if (previous && pending.has(previous.state)) throw Object.assign(new Error("已有待完成任务，请先继续或暂停它。"), { status: 409 });
    const task = { id: randomUUID(), type, projectId, sourceFile, mode, unitIds, languages, state: "queued", cycle: 0, createdAt: new Date().toISOString() };
    await ensureDir(path.join(root, ".runtime"));
    await writeJson(taskFile(root), task);
    try { return await launch(root, task); }
    catch (error) { await writeJson(taskFile(root), { ...task, state: "needs_attention", error: `后台进程未启动：${error.message}` }); throw error; }
  });
}

export async function recoverTask(root) {
  return dispatch(root, async () => {
    const task = await taskState(root);
    if (!task || !pending.has(task.state) || task.workerAlive || await translationOwner(root)) return task;
    if (task.state === "queued" && Date.now() - Date.parse(task.createdAt) < 15000 && !task.pid) return task;
    const clean = { ...task };
    for (const key of ["workerAlive", "active", "pauseRequested", "pid"]) delete clean[key];
    clean.restarts = (task.restarts || 0) + 1;
    if (clean.restarts > 3) {
      clean.state = "needs_attention"; clean.error = "后台进程多次退出，已停止自动重启。请检查 .runtime/worker.log。";
      await writeJson(taskFile(root), clean); return clean;
    }
    await writeJson(taskFile(root), clean);
    return launch(root, clean);
  });
}

export async function pauseTask(root, projectId) {
  const task = await taskState(root);
  if (!task || !pending.has(task.state) || task.projectId !== projectId) throw Object.assign(new Error("该项目没有可暂停的后台任务。"), { status: 409 });
  await writeJson(pauseFile(root, task.id), { requestedAt: new Date().toISOString() });
}
