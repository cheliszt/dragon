import test from "node:test";
import assert from "node:assert/strict";
import { currentTask, translationControl } from "../web/task-state.js";

const project = { id: "book", status: "translating", translation: { request: { startedAt: "2026-09-24T16:00:00Z" } } };
const failed = { projectId: "book", pid: 100, state: "needs_attention", active: false, updatedAt: "2026-09-24T15:00:00Z", error: "fetch failed" };
const state = { config: { translationReady: true }, task: failed, active: { projectId: "book", pid: 200 } };

test("a live CLI continuation replaces the obsolete worker error and explains disabled retry", () => {
  assert.equal(currentTask(state, project), null);
  const control = translationControl(state, project);
  assert.equal(control.disabled, true);
  assert.equal(control.label, "翻译与质检进行中…");
  assert.match(control.reason, /断点重试/);
});

test("retry becomes available after the live owner exits; old errors stay superseded", () => {
  const stopped = { ...state, active: null };
  assert.equal(currentTask(stopped, project), null);
  assert.deepEqual(translationControl(stopped, project), { disabled: false, label: "重试翻译与质检", reason: "" });
  const recentFailure = { ...failed, updatedAt: "2026-09-24T17:00:00Z" };
  assert.equal(currentTask({ ...stopped, task: recentFailure }, project), recentFailure);
  assert.equal(translationControl({ ...stopped, task: recentFailure }, { ...project, status: "translation_failed" }).disabled, false);
});

test("completed translation does not revive an old failure after request timestamps are cleared", () => {
  const finished = { ...project, status: "qa_failed", translation: { request: { state: "completed" } } };
  assert.equal(currentTask({ ...state, active: null, task: { ...failed, type: "translation" } }, finished), null);
});

test("current worker retry and pause state remain visible and another project still blocks submission", () => {
  const task = { ...failed, state: "retry_wait", active: true };
  assert.equal(currentTask({ ...state, task, active: { projectId: "book", pid: 100 } }, project), task);
  const paused = { ...state, active: null, task: { ...failed, state: "paused", updatedAt: "2026-09-24T17:00:00Z" } };
  assert.equal(translationControl(paused, project).label, "继续翻译与质检");
  assert.equal(translationControl(paused, project).disabled, false);
  assert.match(translationControl({ ...state, active: { projectId: "another" } }, project).reason, /另一个任务/);
  assert.equal(translationControl({ ...paused, config: { translationReady: false } }, project).disabled, true);
});
