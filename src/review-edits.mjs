import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { readJson, writeJson, writeText, sha256 } from "./utils.mjs";
import { renderReviewHtml } from "./reading-outputs.mjs";
import { withTranslationLock } from "./translation-lock.mjs";
import { cleanReviewSources } from "./source-cleanup.mjs";
import { readAnnotations, saveAnnotationChanges } from "./annotation-store.mjs";
import { annotatedMarkdown, annotationParagraphs, attachAnnotations, rebaseAnnotations } from "./annotations.mjs";
import { publishAnnotationExports } from "./annotation-exports.mjs";
import { attachReviewChecks, readReviewChecks } from "./review-qa.mjs";
import { loadAuthorTerminology } from "./author-terminology.mjs";
import { loadTermBaseline, attachTermBaseline } from "./term-baseline.mjs";
import { applyReviewGrouping, removeResolvedGroupingIssues, groupedReviewChecks } from './review-grouping.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const editDirectory = (dir, version) => path.join(dir, "07_revisions", sha256(version));
export async function readEdits(dir, model) {
  try { return await readJson(path.join(editDirectory(dir, model.version), "current.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { version: model.version, revision: 0, edits: {}, history: [] };
}
export function editedModel(model, edits) {
  return { ...model, editRevision: edits.revision, units: model.units.map((unit) => {
    const edit = edits.edits[unit.id];
    if (!edit) return unit;
    // Old phrase offsets no longer describe the edited paragraph.
    return { ...unit, target: edit.target, editedAt: edit.savedAt, targetMarks: [],
      ...(edit.termExceptions ? { termExceptions: edit.termExceptions } : {}) };
  }) };
}
export async function reviewSnapshot(dir) {
  const base = await readJson(path.join(dir, "04_qa/review-document.json"));
  const edits = await readEdits(dir, base);
  let editions = [];
  try { editions = await readdir(path.join(dir, "07_revisions")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const grouped = applyReviewGrouping(base, edits.grouping);
  const current = removeResolvedGroupingIssues(attachReviewChecks(grouped, cleanReviewSources(editedModel(grouped, edits)), groupedReviewChecks(await readReviewChecks(dir, base.version), edits.grouping)), edits.grouping);
  const annotated = await readAnnotations(dir, current);
  const termBaseline = await loadTermBaseline(dir);
  const model = { ...attachTermBaseline(annotated.model, termBaseline, edits), terminology: await loadAuthorTerminology(dir) };
  return { model, edits,
    archivedEditions: editions.filter((name) => /^[a-f0-9]{64}$/.test(name) && name !== sha256(base.version)).length };
}
export function checkedUnit(snapshot, data) {
  if (snapshot.model.version !== data.version) fail(409, "读稿版本已更新，请刷新；原版本的修订仍保存在项目中。");
  const unit = snapshot.model.units.find((item) => item.id === data.unitId && !item.artifact);
  if (!unit) fail(400, "没有可修订的正文段落。");
  if (unit.target !== data.before) fail(409, "此段译文已被修改，请刷新后比较再应用。草稿没有覆盖新译文。");
  return unit;
}
export async function applyReviewEdit(dir, data, { root } = {}) {
  return withTranslationLock(dir, async () => {
    const snapshot = await reviewSnapshot(dir);
    const unit = checkedUnit(snapshot, data);
    if (data.revision !== snapshot.edits.revision) fail(409, "另一个窗口已更新译文，请刷新后再保存；本次草稿仍保留。");
    if (typeof data.target !== "string" || !data.target.trim() || data.target.length > 50000) fail(400, "译文不能为空，且不能超过 50000 字符。");
    let termExceptions;
    if (data.proposalId !== undefined) {
      if (!/^[a-f0-9-]{36}$/.test(data.proposalId)) fail(400, "草稿编号无效。");
      const proposal = await readJson(path.join(dir, "04_qa/proposals", `${data.proposalId}.json`));
      if (proposal.state !== "completed" || proposal.version !== data.version || proposal.unitId !== data.unitId || proposal.before !== data.before) fail(409, "AI 草稿与当前段落不一致。");
      if (proposal.input?.source !== unit.source) fail(409, '段落原文或分组已变化，请针对当前完整段落重新生成草稿。');
      if (data.target === proposal.translation) termExceptions = proposal.termExceptions || [];
    }
    if (data.target === unit.target) return snapshot;
    return commitReviewChanges(dir, snapshot, [{ unitId: unit.id, before: unit.target, target: data.target,
      method: data.proposalId ? "ai" : "manual", proposalId: data.proposalId || null, ...(termExceptions ? { termExceptions } : {}) }]);
  }, { root, details: { name: "保存译文修订" } });
}

// Caller holds the project lock and has checked the preview's revision. A whole
// batch becomes visible through one edition pointer after every export is ready.
export async function commitReviewChanges(dir, snapshot, changes, { grouping, annotationCatalog, annotationChanges } = {}) {
  const savedAt = new Date().toISOString(), batchId = randomUUID();
  const entries = changes.map((change) => ({ ...change, id: randomUUID(), batchId, savedAt }));
  const edits = { ...snapshot.edits, revision: snapshot.edits.revision + 1, edits: { ...snapshot.edits.edits }, history: [...snapshot.edits.history, ...entries] };
  if (grouping) edits.grouping = grouping;
  for (const change of entries.filter((c) => !c.noteId)) edits.edits[change.unitId] = { ...edits.edits[change.unitId], target: change.target, savedAt,
    ...(change.termExceptions ? { termExceptions: change.termExceptions } : {}) };
  const base = applyReviewGrouping(await readJson(path.join(dir, "04_qa/review-document.json")), edits.grouping);
  const nextModel = removeResolvedGroupingIssues(attachReviewChecks(base, editedModel(grouping ? base : snapshot.model, edits), groupedReviewChecks(await readReviewChecks(dir, base.version), edits.grouping)), edits.grouping);
  const annotations = await readAnnotations(dir, nextModel);
  const noteChanges = entries.filter((c) => c.noteId);
  const nextAnnotationChanges = annotationChanges || (annotations.changes ? structuredClone(annotations.changes) : null);
  if (noteChanges.length && !nextAnnotationChanges) fail(409, '原注版本已变化，请重新预览。');
  if (noteChanges.length) {
    nextAnnotationChanges.revision++;
    nextAnnotationChanges.history ||= [];
    nextAnnotationChanges.history.push({ id: batchId, savedAt, kind: 'terminology', before: { notes: annotations.changes.notes, translatorNotes: annotations.changes.translatorNotes } });
    for (const c of noteChanges) nextAnnotationChanges.notes[c.noteId] = { ...nextAnnotationChanges.notes[c.noteId], translation: c.target, termExceptions: c.termExceptions || [], editedAt: savedAt };
  }
  let nextCatalog = annotationCatalog || annotations.catalog;
  if (nextCatalog) for (const change of entries.filter((c) => !c.noteId)) {
    const before = grouping ? change.groupedBefore : change.before;
    if (before !== undefined) nextCatalog = rebaseAnnotations(nextCatalog, change.unitId, before, change.target);
  }
  const model = attachTermBaseline(nextCatalog ? attachAnnotations(nextModel, nextCatalog, nextAnnotationChanges) : nextModel,
    await loadTermBaseline(dir), edits);
  const units = model.units.filter((u) => !u.artifact);
  const chinese = model.annotations ? annotatedMarkdown(model) : units.map((u) => u.target).join("\n\n") + "\n";
  const bilingual = model.annotations ? annotatedMarkdown(model, { bilingual: true }) : units.map((u) => `${u.source}\n\n${u.target}`).join("\n\n---\n\n") + "\n";
  const directory = editDirectory(dir, model.version), bundle = path.join(directory, batchId);
  const manifest = await readJson(path.join(dir, "manifest.json"));
  const pdfUrl = manifest.source.originalFile ? path.relative(bundle, path.join(dir, manifest.source.originalFile)).split(path.sep).map((s) => s === ".." ? s : encodeURIComponent(s)).join("/") : null;
  await writeText(path.join(bundle, "project_zh.md"), chinese);
  await writeText(path.join(bundle, "project_bilingual.md"), bilingual);
  await writeText(path.join(bundle, "project_bilingual.html"), await renderReviewHtml(model, { pdfUrl }));
  edits.outputs = Object.fromEntries(Object.entries({ chinese: "project_zh.md", bilingual: "project_bilingual.md", bilingualHtml: "project_bilingual.html" })
    .map(([kind, file]) => [kind, path.relative(dir, path.join(bundle, file))]));
  await writeJson(path.join(bundle, "revision.json"), edits);
  if (nextCatalog) {
    await writeJson(path.join(bundle, "annotations-before.json"), annotations.catalog);
    await writeJson(path.join(annotations.folder, "catalog.json"), nextCatalog);
    if (noteChanges.length || annotationChanges) await saveAnnotationChanges(annotations.folder, nextAnnotationChanges);
  }
  await writeJson(path.join(directory, "current.json"), edits);
  if (model.annotations) await publishAnnotationExports(dir, model);
  return reviewSnapshot(dir);
}

export async function applyAnnotationEdit(dir, data, { root } = {}) {
  return withTranslationLock(dir, async () => {
    const snapshot = await reviewSnapshot(dir);
    if (snapshot.model.version !== data.version) fail(409, "读稿版本已更新，请刷新后再保存注释。");
    const stored = await readAnnotations(dir, snapshot.model);
    if (!stored.catalog) fail(409, "注释尚未整理完成。");
    if (data.revision !== stored.changes.revision) fail(409, "注释已在另一窗口更新，本次草稿已保留。");
    const next = structuredClone(stored.changes);
    const before = structuredClone(stored.changes);
    const validText = (text) => typeof text === "string" && text.trim() && text.length <= 50000;
    if (data.kind === "author") {
      const original = stored.catalog.notes.find((n) => n.id === data.noteId);
      if (!original) fail(400, "原注不存在。");
      if (!validText(data.source) || !validText(data.translation)) fail(400, "原注与注译均不能为空，且不能超过50000字。");
      next.notes[data.noteId] = { source: data.source, translation: data.translation, editedAt: new Date().toISOString() };
    } else if (data.kind === "translator") {
      const unit = snapshot.model.units.find((u) => u.id === data.unitId && !u.artifact);
      if (!unit || typeof data.paragraphId !== "string" || !annotationParagraphs(unit).some((p) => p.id === data.paragraphId)) fail(400, "译注所属段落无效。");
      const at = next.translatorNotes.findIndex((n) => n.id === data.noteId);
      if (data.delete) {
        if (at < 0 || next.translatorNotes[at].unitId !== unit.id) fail(400, "译注不存在。");
        next.translatorNotes.splice(at, 1);
      } else {
        if (!validText(data.text)) fail(400, "译注不能为空，且不能超过50000字。");
        if (data.noteId && (at < 0 || next.translatorNotes[at].unitId !== unit.id)) fail(400, "译注不存在。");
        const note = { id: data.noteId || randomUUID(), unitId: unit.id, paragraphId: data.paragraphId, text: data.text, savedAt: new Date().toISOString() };
        if (at < 0) next.translatorNotes.push(note); else next.translatorNotes[at] = note;
      }
    } else fail(400, "无效注释类型。");
    next.revision++; next.history ||= [];
    next.history.push({ id: randomUUID(), savedAt: new Date().toISOString(), kind: data.kind, noteId: data.noteId || null,
      before: { notes: before.notes, translatorNotes: before.translatorNotes } });
    await saveAnnotationChanges(stored.folder, next);
    const result = await reviewSnapshot(dir);
    await publishAnnotationExports(dir, result.model);
    return result;
  }, { root, details: { name: "保存原注与译注" } });
}
