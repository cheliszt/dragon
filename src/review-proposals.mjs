import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { APP_ROOT, loadConfig, loadPromptFiles, requireSecret } from "./config.mjs";
import { OpenAIClient } from "./openai-client.mjs";
import { readJson, writeJson } from "./utils.mjs";
import { reviewSnapshot, checkedUnit } from "./review-edits.mjs";
import { withTranslationLock } from "./translation-lock.mjs";
import { loadAuthorTerminology, terminologyContext } from "./author-terminology.mjs";
import { projectLanguages } from "./languages.mjs";
import { loadTermBaseline, termContext } from "./term-baseline.mjs";

const location = (dir, id) => path.join(dir, "04_qa/proposals", `${id}.json`);
const alive = (pid) => { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } };
export async function listProposals(dir, version) {
  let files;
  try { files = await readdir(path.join(dir, "04_qa/proposals")); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const results = [];
  for (const file of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const p = await readJson(path.join(dir, "04_qa/proposals", file));
    if (p.version !== version) continue;
    if (["queued", "running"].includes(p.state) && !alive(p.pid) && Date.now() - Date.parse(p.createdAt) > 30000) {
      p.state = "failed"; p.error = "修订进程已中断，原译文未改动；可重新生成草稿。";
      await writeJson(location(dir, p.id), p);
    }
    const { input, ...publicProposal } = p;
    results.push(publicProposal);
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function startProposal(dir, data, { root, revise } = {}) {
  return withTranslationLock(dir, async () => {
    const snapshot = await reviewSnapshot(dir);
    const unit = checkedUnit(snapshot, data);
    const issue = snapshot.model.issues.find((q) => q.id === data.issueId && unit.issueIds.includes(q.id));
    if (!issue || typeof data.note !== "string" || data.note.length > 5000) throw Object.assign(new Error("修订意见或关联问题无效。"), { status: 400 });
    if ((await listProposals(dir, data.version)).some((p) => ["queued", "running"].includes(p.state))) throw Object.assign(new Error("已有 AI 修订正在生成，请等待结果。"), { status: 409 });
    const at = snapshot.model.units.findIndex((u) => u.id === unit.id);
    const p = { id: randomUUID(), version: data.version, unitId: unit.id, issueId: issue.id,
      before: unit.target, note: data.note, createdAt: new Date().toISOString(), state: "queued",
      sourceCleanup: snapshot.model.sourceCleanup,
      input: { source: unit.source, translation: unit.target, suggestion: issue.recommendation,
        languageSegments: unit.languageSegments,
        section: unit.section, noteCallouts: unit.noteCallouts,
        problem: issue.description, userComment: data.note, humanRevision: snapshot.edits.revision,
        previousQaStale: unit.qa?.state === "stale",
        removedSourceMarkers: snapshot.model.sourceCleanup.removals.filter((r) => r.block_id === unit.id)
          .map(({ removed, reason, context }) => ({ removed, reason, context })),
        context: [snapshot.model.units[at - 1], snapshot.model.units[at + 1]].filter((u) => u && !u.artifact).map((u) => ({ source: u.source, translation: u.target, section: u.section, noteCallouts: u.noteCallouts })) } };
    await writeJson(location(dir, p.id), p);
    return p;
  }, { root, details: { name: "提交 AI 修订" } }).then(async (p) => {
    if (revise) {
      p.pid = process.pid; await writeJson(location(dir, p.id), p);
      void runProposal(root, dir, p.id, revise);
    } else {
      const child = spawn(process.execPath, [path.join(APP_ROOT, "src/review-proposal-worker.mjs"), root, dir, p.id], {
        cwd: root, windowsHide: true, detached: true, stdio: "ignore"
      });
      child.on("error", async () => { p.state = "failed"; p.error = "无法启动 AI 修订进程，请重试。"; await writeJson(location(dir, p.id), p).catch(() => {}); });
      child.unref();
    }
    return { id: p.id, state: "queued" };
  });
}
export async function runProposal(root, dir, id, revise) {
  const p = await readJson(location(dir, id));
  try {
    await withTranslationLock(dir, async () => {
      p.pid = process.pid; p.state = "running"; await writeJson(location(dir, id), p);
      if (!revise) {
        const config = await loadConfig(root);
        const prompts = await loadPromptFiles(path.join(dir, "00_shared"));
        const client = new OpenAIClient({ ...config.openai, apiKey: requireSecret("OPENAI_API_KEY") });
        const authorTerminology = terminologyContext(await loadAuthorTerminology(dir));
        const languages = projectLanguages(await readJson(path.join(dir, "manifest.json")), config);
        const termBaseline = termContext(await loadTermBaseline(dir));
        revise = (input) => client.revise(input, { ...languages, styleGuide: prompts["style-guide.md"], glossary: prompts["glossary.md"], authorTerminology, termBaseline });
      }
      const result = await revise(p.input);
      const value = result.value;
      if (typeof value?.translation !== "string" || !value.translation.trim() || value.translation.length > 50000 || typeof value.explanation !== "string") throw new Error("AI 未返回有效修订稿，请重试。");
      p.state = "completed"; p.translation = value.translation; p.explanation = value.explanation;
      p.termExceptions = value.term_exceptions || [];
      p.responseId = result.responseId; p.usage = result.usage;
      p.completedAt = new Date().toISOString();
      await writeJson(location(dir, id), p);
    }, { root: path.join(root || APP_ROOT, ".runtime/review-proposals"), details: { name: "AI 段落修订" } });
  } catch (e) { p.state = "failed"; p.error = e.message; await writeJson(location(dir, id), p); }
}
