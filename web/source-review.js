import { findSourceIssues, resolveSourceIssue } from "./source-issues.js";

export function mountSourceReview({ editor, onChange, onPage }) {
  const $ = (id) => document.getElementById(id);
  let projectId, source, issues = [], index = 0, editable = false, undo = null;

  function draw() {
    $("source-issue-count").textContent = `待核对 ${issues.length} 处`;
    $("source-issue-empty").hidden = issues.length > 0;
    $("source-issue-detail").hidden = !issues.length;
    $("source-issue-select").hidden = !issues.length;
    $("source-issue-previous").disabled = index <= 0 || !issues.length;
    $("source-issue-next").disabled = index >= issues.length - 1;
    $("source-issue-resolve").disabled = !editable || !issues.length;
    $("source-issue-undo").hidden = !undo;
    $("source-issue-undo").disabled = !editable || editor.value !== undo?.after;
    const issue = issues[index];
    if (!issue) return;
    $("source-issue-select").value = String(index);
    $("source-issue-position").textContent = `${index + 1} / ${issues.length} · ${issue.page ? `PDF 第 ${issue.page} 页` : "页码未知"} · 第 ${issue.line} 行${issue.blockId ? ` · ${issue.blockId}` : ""}`;
    $("source-issue-reason").textContent = `${issue.marker}：${issue.reason || "请对照原件核对该处文字。"}`;
    $("source-issue-context").textContent = issue.context || "此处暂无提取文字，请查看 PDF 原页。";
  }

  function update({ id, visible, canEdit }) {
    $("source-review").hidden = !visible;
    editable = canEdit;
    if (projectId !== id) { projectId = id; source = undefined; index = 0; undo = null; }
    if (source !== editor.value) {
      const offset = issues[index]?.start ?? 0;
      source = editor.value;
      issues = findSourceIssues(source);
      index = Math.max(0, issues.findIndex((issue) => issue.start >= offset));
      if (undo && undo.after !== source) undo = null;
      $("source-issue-select").replaceChildren(...issues.map((issue, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = `${i + 1}. ${issue.page ? `PDF 第 ${issue.page} 页` : `第 ${issue.line} 行`} · ${issue.marker}`;
        return option;
      }));
    }
    draw();
  }

  function locate() {
    const issue = issues[index];
    if (!issue) return;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(issue.start, issue.end);
    // A matching text layout gives the wrapped-line position even in book-length drafts.
    const mirror = document.createElement("div");
    const style = getComputedStyle(editor);
    for (const key of ["font", "lineHeight", "letterSpacing", "padding", "boxSizing", "wordBreak", "overflowWrap", "tabSize"]) mirror.style[key] = style[key];
    Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", width: `${editor.clientWidth}px` });
    mirror.textContent = editor.value.slice(0, issue.start);
    const marker = document.createElement("span");
    marker.textContent = editor.value.slice(issue.start, issue.end);
    mirror.append(marker);
    document.body.append(mirror);
    editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 3);
    mirror.remove();
    if (issue.page) onPage(issue.page);
  }

  $("source-issue-select").onchange = (event) => { index = Number(event.target.value); draw(); locate(); };
  $("source-issue-previous").onclick = () => { if (index > 0) { index -= 1; draw(); locate(); } };
  $("source-issue-next").onclick = () => { if (index + 1 < issues.length) { index += 1; draw(); locate(); } };
  $("source-issue-locate").onclick = locate;
  $("source-issue-resolve").onclick = () => {
    if (!editable || !issues[index]) return;
    const before = editor.value;
    const after = resolveSourceIssue(before, issues[index]);
    undo = { before, after };
    editor.value = after;
    onChange("已移除此处标记。请保存校对，或继续核对下一处。");
    locate();
  };
  $("source-issue-undo").onclick = () => {
    if (!editable || !undo || editor.value !== undo.after) return;
    editor.value = undo.before;
    undo = null;
    onChange("已撤销上次确认，请保存校对。");
  };
  return { update, locateFirst() { index = 0; draw(); locate(); }, count: () => issues.length };
}
