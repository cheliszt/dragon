export function reviewMatches(unit, query, field = "source", wholeWord = false) {
  if (!query.trim()) return [];
  const literal = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal, "giu");
  const texts = [{ field: "source", text: unit.source }, { field: "target", text: unit.target }];
  for (const r of [...new Map((unit.authorNotes || []).filter((r) => r.inlineNote !== false).map((r) => [r.noteId, r])).values()]) {
    texts.push({ field: "notes", side: "source", noteId: r.noteId, text: r.note.source },
      { field: "notes", side: "target", noteId: r.noteId, text: r.note.translation });
  }
  for (const n of unit.translatorNotes || []) texts.push({ field: "notes", noteId: n.id, text: n.text });
  return texts.filter((t) => field === "all" || t.field === field).flatMap((t) => [...(t.text || "").matchAll(pattern)]
    .map((m) => ({ ...t, unitId: unit.id, start: m.index, end: m.index + m[0].length })));
}

// Embedded together with reviewMatches in downloadable HTML.
export function mountReview(root, model, options = {}) {
  root.replaceChildren();
  root.className = "review-reader";
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  let issues = new Map(model.issues.map((q) => [q.id, q]));
  const qaMode = options.mode === "qa";
  const storageKey = `translation-review-${model.version}`;
  let state = options.state || { version: model.version, issues: {}, scopes: {} };
  if (!options.onSave) { try { state = JSON.parse(localStorage.getItem(storageKey)) || state; } catch {} }
  if (state.version !== model.version) state = { version: model.version, issues: {}, scopes: {} };
  state.issues ||= {}; state.scopes ||= {};
  const savedNotes = new Map(Object.entries(state.issues).map(([id, value]) => [id, value.note || ""]));
  let edits = options.edits || { revision: model.editRevision || 0, history: [] };
  let proposals = options.proposals || [];
  const draftKey = `${storageKey}-drafts`;
  const offlineKey = `${storageKey}-text-${model.editRevision || 0}`;
  let drafts = {};
  const annotationDraftKey = `${storageKey}-annotation-drafts`;
  let annotationDrafts = {};
  try { annotationDrafts = JSON.parse(localStorage.getItem(annotationDraftKey)) || {}; } catch {}
  const persistAnnotationDrafts = () => { try { localStorage.setItem(annotationDraftKey, JSON.stringify(annotationDrafts)); } catch { status.textContent = "注释草稿暂存失败，请尽快保存。"; } };
  try { drafts = JSON.parse(localStorage.getItem(draftKey)) || {}; } catch {}
  if (!options.onEdit) {
    try {
      const local = JSON.parse(localStorage.getItem(offlineKey));
      if (local) { edits = local.edits; model = local.model; }
    } catch {}
  }
  const persistDrafts = () => { try { localStorage.setItem(draftKey, JSON.stringify(drafts)); } catch { status.textContent = "草稿暂存失败，请保留页面并尽快保存译文。"; } };
  let editing = false, generating = false;
  const openContexts = new Set();
  let scope = options.mode === "qa" ? "body" : "all", filter = "all", query = "", pendingOnly = options.mode === "qa";
  let searchField = "source", wholeWord = false, selectedHit = 0, qaFilter = "all", remoteSnapshot = null;
  let page = 0, selectedIssue = null, saveQueue = Promise.resolve();
  const pageSize = 8;
  const toolbar = el("div", undefined, "review-toolbar");
  const count = el("p", "", "review-count");
  const status = el("p", "", "review-save"); status.setAttribute("role", "status");
  const list = el("div", undefined, "review-list");
  const pager = el("div", undefined, "review-pager");
  const select = (label, choices, value, change) => {
    const wrap = el("label", label), input = el("select"); input.setAttribute("aria-label", label);
    for (const [v, text] of choices) { const opt = el("option", text); opt.value = v; input.append(opt); }
    input.value = value; input.onchange = () => change(input.value); wrap.append(input); return wrap;
  };
  const button = (text, title, run) => { const b = el("button", text, "secondary"); b.type = "button"; b.title = title; b.setAttribute("aria-label", title); b.onclick = run; return b; };
  const scopeSelect = select("审阅范围", [["body", "正文（含目录、注释、参考文献）"], ["auxiliary", "辅助内容与排版"], ["all", "全部内容"]], scope, (v) => { scope = v; page = 0; render(); });
  const severitySelect = select("问题级别", [["all", "全部级别"], ["blocking", "重点核查"], ["warning", "一般警告"], ["note", "提示与译者说明"]], filter, (v) => { filter = v; page = 0; render(); });
  const searchLabel = el("label", "全文检索"), search = el("input"); search.type = "search"; search.placeholder = "搜索词句或疑点"; search.setAttribute("aria-label", "全文检索");
  search.placeholder = "coworker / 黑人性";
  search.oninput = () => { query = search.value.trim(); page = 0; selectedHit = 0; render(); }; searchLabel.append(search);
  const fieldSelect = select("搜索字段", [["source", "原文"], ["target", "译文"], ["notes", "原注与译注"], ["all", "原文、译文与注释"]], searchField,
    (v) => { searchField = v; page = 0; selectedHit = 0; render(); });
  const wholeLabel = el("label", undefined, "review-check"), whole = el("input"); whole.type = "checkbox";
  whole.onchange = () => { wholeWord = whole.checked; page = 0; selectedHit = 0; render(); };
  wholeLabel.append(whole, document.createTextNode("整词匹配"));
  const qaSelect = select("质检版本", [["all", "全部"], ["current", "当前稿结论"], ["stale", "修改后待重新质检"]], qaFilter, (v) => { qaFilter = v; page = 0; render(); });
  const pendingLabel = el("label", undefined, "review-check"), pending = el("input"); pending.type = "checkbox"; pending.checked = pendingOnly;
  pending.onchange = () => { pendingOnly = pending.checked; page = 0; render(); }; pendingLabel.append(pending, document.createTextNode("仅看未处理问题"));
  const download = button("↓", "下载审阅记录", () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
    const a = el("a"); a.href = url; a.download = "review-decisions.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  toolbar.append(scopeSelect, fieldSelect, searchLabel, wholeLabel);
  if (qaMode) toolbar.append(severitySelect, qaSelect, pendingLabel, download);
  if (options.onSnapshot) toolbar.append(button("↻", "同步当前书稿并保留本地草稿", () => syncSnapshot(true)));
  async function recheck(unitIds, mode = "changed") {
    try {
      await options.onRecheck({ version: model.version, revision: edits.revision, mode, ...(unitIds ? { unitIds } : {}) });
      status.textContent = "已提交当前修订稿质检；结果只更新核查意见，正文仍可编辑。";
    } catch (e) { status.textContent = e.message; }
  }
  if (qaMode && options.onRecheck) {
    toolbar.append(button("质检已修改段落", "根据当前人工译文重新质检修改过的段落", () => recheck()));
    toolbar.append(button("质检全稿", "根据当前人工译文重新质检全书", () => recheck(undefined, "all")));
  }
  if (options.onPrepareAnnotations && model.annotations?.authorNotePlacement !== "source") toolbar.append(button("整理段后注释", "识别、翻译作者原注并更新段落对应位置", async () => {
    try { await options.onPrepareAnnotations(); status.textContent = "正在整理段后注释，完成后重新打开本视图即可。"; }
    catch (e) { status.textContent = e.message; }
  }));
  if (!options.onEdit) toolbar.append(button("下载修订译文稿", "下载当前译文", () => {
    const text = model.units.filter((u) => !u.artifact).flatMap((u) => paragraphViews(u).map((p) => {
      let target = p.target;
      for (const r of [...p.references].sort((a, b) => b.targetOffset - a.targetOffset)) {
        if (!r.existingMarker && r.targetOffset !== null) { const at = r.targetOffset - p.targetStart; target = target.slice(0, at) + `[${r.label}]` + target.slice(at); }
      }
      const notes = [...new Map(p.references.filter((r) => r.inlineNote !== false).map((r) => [r.noteId, r])).values()].map((r) => `> 作者原注 ${r.label}\n> ${r.note.translation || "[原注待翻译]"}`);
      return [target, ...notes, ...p.translatorNotes.map((n) => `> 译注\n> ${n.text}`)].join("\n\n");
    })).join("\n\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = el("a"); a.href = url; a.download = model.languages?.targetLanguage === "en" ? "project_en_revised.md" : "project_zh_revised.md"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  const concordance = el("details", undefined, "term-concordance");
  const termPanel = el("section", undefined, "term-manager"); termPanel.hidden = true;
  const termsButton = button("规定术语译法", "为检索词规定全书统一译法", () => openTermManager());
  if (options.onTerms) toolbar.append(termsButton);
  toolbar.append(button('术语基线', '查看固定术语及原文依据', () => {
    termPanel.hidden = false; termPanel.replaceChildren();
    const baseline = model.termBaseline;
    termPanel.append(el('h3', '全书固定术语'), el('p', baseline?.status === 'ready'
      ? `已分析全部 ${baseline.coverage?.blocks || 0} 个原文单元；${baseline.entries.length} 个固定译法。`
      : '全篇译前分析尚未完成；下列人工规定的译法已生效。'));
    for (const entry of baseline?.entries || []) {
      const item = el('details'); item.append(el('summary', `${entry.term} → ${entry.translation}${entry.origin === 'user' ? '（人工规定）' : ''}`), el('p', entry.definition));
      for (const evidence of entry.evidence || []) item.append(el('p', `PDF ${evidence.page || '—'} · ${evidence.blockId}\n${evidence.quote}`));
      if (options.onTerms) item.append(button('编辑译法', `编辑 ${entry.term} 的固定译法`, () => openTermManager(entry.term)));
      termPanel.append(item);
    }
    termPanel.append(button('关闭', '关闭术语基线', () => { termPanel.hidden = true; }));
  }));
  root.append(toolbar, count, status, termPanel, concordance, list, pager);
  const accept = (result) => { model = result.model; edits = result.edits; issues = new Map(model.issues.map((q) => [q.id, q])); };
  async function syncSnapshot(explicit = false) {
    try {
      const next = explicit && remoteSnapshot ? remoteSnapshot : await options.onSnapshot();
      if (!root.contains(list)) return;
      if (next.model.version !== model.version) { status.textContent = "读稿版本已变化，请保存本地草稿后重新打开书稿。"; return; }
      const changed = next.edits.revision !== edits.revision || next.model.qaRevision !== model.qaRevision || next.model.annotations?.revision !== model.annotations?.revision
        || next.model.termBaseline?.revision !== model.termBaseline?.revision;
      if (!changed) return;
      if (!explicit && (Object.keys(drafts).length || Object.keys(annotationDrafts).length || root.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA")) {
        remoteSnapshot = next; status.textContent = "当前书稿或质检已更新。同步后会保留本地草稿并检查冲突。"; return;
      }
      accept(next); remoteSnapshot = null; render();
      status.textContent = `已同步当前书稿 · 修订 ${edits.revision}`;
    } catch (e) { if (explicit) status.textContent = e.message; }
  }
  async function watchSnapshot() {
    if (!root.contains(list)) return;
    await syncSnapshot();
    if (root.contains(list)) setTimeout(watchSnapshot, 4000);
  }
  if (options.archivedEditions) status.textContent = "旧读稿的修订已保存在项目 07_revisions 中，未自动套用到新读稿。";
  const issueState = (id) => state.issues[id]?.status || "pending";
  function openTermManager(termQuery = query) {
    termPanel.hidden = false; termPanel.replaceChildren();
    termPanel.append(el('h3', '固定术语译法'), el('p', '先保存标准译法，再检查逐段预览并应用。特殊用意须逐处说明，尽可能沿用标准译法。'));
    const matched = (model.termBaseline?.entries || []).find((e) => [e.term, ...(e.aliases || [])].some((t) => t.toLowerCase() === termQuery.toLowerCase()));
    const field = (label, value, multiline = false) => {
      const wrap = el('label', label), input = el(multiline ? 'textarea' : 'input'); input.value = value || ''; input.setAttribute('aria-label', label);
      wrap.append(input); termPanel.append(wrap); return input;
    };
    const sourceTerm = field('源语术语', matched?.term || termQuery);
    const targetTerm = field('全书标准译法', matched?.translation);
    const aliases = field('源词变体（每行一个，含单复数）', (matched?.aliases || []).join('\n'), true);
    const variants = field('需要统一的旧译法（每行一个）', (matched?.variants || []).join('\n'), true);
    const definition = field('概念含义与原文依据', matched?.definition, true);
    const feedback = el('p', '', 'review-save'); feedback.setAttribute('role', 'status');
    const rows = el('div', undefined, 'term-preview');
    let savedId = matched?.id || null, preview = null;
    let dirty = !matched;
    for (const input of [sourceTerm, targetTerm, aliases, variants, definition]) input.oninput = () => {
      dirty = true; preview = null; rows.replaceChildren(); feedback.textContent = '规则已修改，请先保存标准译法，再重新预览。';
    };
    const data = () => ({ version: model.version, revision: edits.revision, termRevision: model.termBaseline?.revision || 0, annotationRevision: model.annotations?.revision || 0 });
    const split = (value) => value.split(/\n|[;；]/).map((s) => s.trim()).filter(Boolean);
    const save = button('保存标准译法', '保存此术语的全书标准译法', async () => {
      save.disabled = true;
      try {
        const result = await options.onTerms({ ...data(), action: 'save', entry: { term: sourceTerm.value, translation: targetTerm.value,
          aliases: split(aliases.value), variants: split(variants.value), definition: definition.value } });
        accept(result); savedId = result.entry.id; dirty = false; preview = null; rows.replaceChildren();
        feedback.textContent = '标准译法已保存。请预览将被统一的段落；现有译文尚未改变。'; render();
      } catch (e) { feedback.textContent = e.message; } finally { save.disabled = false; }
    });
    const previewButton = button('预览全文修改', '按已保存的术语规则预览全文修改', async () => {
      if (!savedId || dirty) { feedback.textContent = '请先保存标准译法。'; return; }
      previewButton.disabled = true;
      try {
        preview = await options.onTerms({ ...data(), action: 'preview', termId: savedId });
        rows.replaceChildren();
        const selected = new Set(preview.rows.filter((r) => r.selected).map((r) => r.unitId));
        rows.append(el('p', `全文命中 ${preview.rows.length} 段，${preview.rows.filter((r) => r.replacements.length).length} 段有可统一的旧译法。`));
        const apply = button('应用所选段落', '将所选段落统一为标准译法并保存修订历史', async () => {
          apply.disabled = true;
          try {
            const result = await options.onTerms({ ...data(), action: 'apply', termId: savedId, previewId: preview.id, previewHash: preview.hash, unitIds: [...selected] });
            accept(result); rows.replaceChildren(); preview = null; render();
            feedback.textContent = `所选段落已统一，修订 ${edits.revision}。其他人工修订已保留。`;
          } catch (e) { feedback.textContent = e.message; } finally { apply.disabled = false; }
        });
        rows.append(apply);
        for (const row of preview.rows) {
          const detail = el('details'), summary = el('summary', `${row.noteId ? '作者原注 · ' : ''}PDF ${row.page || '—'} · ${row.unitId} · ${row.replacements.length} 处可修改`);
          detail.append(summary);
          if (row.replacements.length) {
            const label = el('label'), checked = el('input'); checked.type = 'checkbox'; checked.checked = selected.has(row.unitId);
            checked.setAttribute('aria-label', `统一 ${row.unitId}`); checked.onchange = () => checked.checked ? selected.add(row.unitId) : selected.delete(row.unitId);
            label.append(checked, document.createTextNode('应用本段修改')); detail.append(label);
          }
          if (row.caution) detail.append(el('p', row.caution, 'review-qa-stale'));
          detail.append(el('h4','原文'), el('p',row.source), el('h4','修改前'), el('p',row.before), el('h4','统一后'), el('p',row.target));
          const exception = el('details'); exception.append(el('summary', '记录一处特殊用意的例外'));
          const exceptionField = (label, value, type = 'text') => {
            const wrap = el('label',label), input = el(type === 'textarea' ? 'textarea' : 'input');
            if (type !== 'textarea') input.type = type; input.value = value; input.setAttribute('aria-label', `${row.unitId} ${label}`); wrap.append(input); exception.append(wrap); return input;
          };
          const quote = exceptionField('原文引句','');
          const sourceOccurrence = exceptionField('原词含变体在本段第几次出现','1','number'); sourceOccurrence.min = '1';
          const variant = exceptionField('此处替代译法',row.replacements[0]?.before || '');
          const occurrence = exceptionField('替代短语在本段第几次出现','1','number'); occurrence.min = '1';
          const reason = exceptionField('特殊语义依据（逐处说明）','','textarea');
          exception.append(button('保存本处例外', `保存 ${row.unitId} 的一处术语例外`, async () => {
            try {
              const result = await options.onTerms({ ...data(), action: 'exception', termId: savedId, unitId: row.unitId,
                exception: { source_quote: quote.value, source_occurrence: Number(sourceOccurrence.value), translation_quote: variant.value, occurrence: Number(occurrence.value), reason: reason.value } });
              accept(result); preview = null; rows.replaceChildren(); render(); feedback.textContent = '本处例外及依据已保存到段落审阅。继续统一其他段落前请重新预览。';
            } catch (e) { feedback.textContent = e.message; }
          }));
          detail.append(exception); rows.append(detail);
        }
      } catch (e) { feedback.textContent = e.message; } finally { previewButton.disabled = false; }
    });
    termPanel.append(save, previewButton, button('关闭', '关闭术语管理', () => { termPanel.hidden = true; }), feedback, rows);
  }
  const matching = (unit) => unit.issueIds.map((id) => issues.get(id)).filter(Boolean).filter((q) =>
    (filter === "all" || q.severity === filter) && (!pendingOnly || (issueState(q.id) === "pending" && (filter !== "all" || q.severity !== "note"))));
  const unitScope = (u) => state.scopes[u.blockId] || u.scope;
  function save(feedback) {
    const snapshot = JSON.parse(JSON.stringify(state));
    status.textContent = "正在保存审阅记录…";
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      if (options.onSave) await options.onSave(snapshot);
      else localStorage.setItem(storageKey, JSON.stringify(snapshot));
      for (const [id, value] of Object.entries(snapshot.issues)) savedNotes.set(id, value.note || "");
      status.textContent = options.onSave ? "审阅记录已保存到项目" : "审阅记录已保存到此浏览器";
      if (feedback) feedback.textContent = "意见已保存，译文尚未改动。";
    }).catch((error) => { status.textContent = `保存未成功：${error.message}。可下载审阅记录保留本次判断。`; if (feedback) feedback.textContent = `意见未保存：${error.message}`; });
    return saveQueue;
  }
  function draftFor(unit, values = {}) {
    if (drafts[unit.id]) { status.textContent = "本段已有未应用草稿，请先应用或放弃，避免覆盖。"; return; }
    let target = unit.target;
    for (const r of [...(unit.authorNotes || [])].sort((a, b) => b.targetOffset - a.targetOffset)) {
      if (Number.isInteger(r.targetOffset) && !r.existingMarker) target = target.slice(0, r.targetOffset) + `[${r.label}]` + target.slice(r.targetOffset);
    }
    drafts[unit.id] = { before: unit.target, target, ...values };
    persistDrafts(); render();
  }
  async function applyDraft(unit) {
    if (editing) return;
    editing = true;
    const draft = { ...drafts[unit.id] };
    render();
    try {
      if (options.onEdit) {
        const result = await options.onEdit({ version: model.version, revision: edits.revision, unitId: unit.id,
          before: draft.before, target: draft.target, ...(draft.proposalId ? { proposalId: draft.proposalId } : {}) });
        accept(result);
      } else {
        if (draft.before !== unit.target) throw new Error("此段已变化，请保留草稿并重新核对。");
        const savedAt = new Date().toISOString();
        const nextEdits = { revision: edits.revision + 1, history: [...edits.history, { unitId: unit.id, before: unit.target, target: draft.target, savedAt, method: "manual" }] };
        const nextModel = { ...model, editRevision: nextEdits.revision, units: model.units.map((u) => u.id === unit.id ? { ...u, target: draft.target, targetMarks: [], sourceMarks: [], editedAt: savedAt,
          qa: { ...u.qa, state: "stale", basisTarget: u.qa?.basisTarget || u.target } } : u) };
        localStorage.setItem(offlineKey, JSON.stringify({ edits: nextEdits, model: nextModel }));
        edits = nextEdits; model = nextModel;
      }
      delete drafts[unit.id]; persistDrafts();
      status.textContent = options.onEdit ? "修订已应用，译文稿与双语下载稿已同步更新。疑点仍待核查。" : "修订已保存到此浏览器，可下载修订译文稿；未写回项目。";
    } catch (error) { status.textContent = `修订未应用：${error.message}`; }
    finally { editing = false; render(); }
  }
  function editor(unit) {
    const wrap = el("div", undefined, "review-editor");
    const tools = el("div", undefined, "review-edit-actions");
    tools.append(button("编辑译文", "编辑本段译文", () => draftFor(unit)));
    if (unit.editedAt) tools.append(el("span", unit.issueIds.some((id) => issueState(id) === "pending") ? "已修改 · 待复核" : "已修改", "review-location"));
    wrap.append(tools);
    const draft = drafts[unit.id];
    if (draft) {
      const label = el("label", draft.proposalId ? "AI 修订草稿" : "译文修订草稿");
      const input = el("textarea"); input.rows = 7; input.value = draft.target; input.maxLength = 50000; input.setAttribute("aria-label", "译文修订草稿");
      input.oninput = () => { draft.target = input.value; persistDrafts(); apply.disabled = editing || !input.value.trim() || draft.before !== unit.target; };
      input.disabled = editing; label.append(input); wrap.append(label);
      if (draft.explanation) wrap.append(el("p", draft.explanation, "review-recommendation"));
      if (draft.before !== unit.target) wrap.append(el("p", "当前译文已更新，草稿已保留。请比较后重新编辑。", "review-edit-conflict"));
      const comparison = el("details"); comparison.append(el("summary", "比较修改前译文"), el("p", draft.before, "review-paragraph")); wrap.append(comparison);
      const actions = el("div", undefined, "review-edit-actions");
      const apply = button(editing ? "正在保存…" : "应用修订", "保存本段修订并更新导出稿", () => applyDraft(unit));
      apply.disabled = editing || !draft.target.trim() || draft.before !== unit.target;
      const cancel = button("放弃草稿", "放弃当前修订草稿", () => { delete drafts[unit.id]; persistDrafts(); render(); }); cancel.disabled = editing;
      actions.append(apply, cancel); wrap.append(actions);
    }
    const history = edits.history.filter((entry) => entry.unitId === unit.id);
    if (history.length) {
      const details = el("details", undefined, "review-history"); details.append(el("summary", `修订历史 ${history.length} 次`));
      for (const entry of [...history].reverse()) {
        const item = el("div"); item.append(el("small", `${new Date(entry.savedAt).toLocaleString()} · ${entry.method === "ai" ? "AI 草稿修订" : "人工修订"}`),
          el("p", entry.before, "review-paragraph"), el("p", entry.target, "review-paragraph"),
          button("恢复此修改前的译文", "将历史译文放入修订草稿", () => draftFor(unit, { target: entry.before })));
        details.append(item);
      }
      wrap.append(details);
    }
    return wrap;
  }
  async function generate(unit, q, note, feedback) {
    if (generating) return;
    generating = true; feedback.textContent = "正在提交 AI 修订…";
    try {
      await options.onPropose({ version: model.version, unitId: unit.id, before: unit.target, issueId: q.id, note });
      await refreshProposals();
    } catch (error) { feedback.textContent = `AI 修订未提交：${error.message}`; status.textContent = feedback.textContent; }
    finally { generating = false; }
  }
  async function refreshProposals() {
    if (!options.onProposals || !root.contains(list)) return;
    const next = await options.onProposals();
    if (!root.contains(list)) return;
    if (JSON.stringify(next) !== JSON.stringify(proposals)) { proposals = next; render(); }
  }
  async function watchProposals() {
    if (!root.contains(list)) return;
    try { await refreshProposals(); } catch (e) { status.textContent = `AI 草稿状态暂不可用：${e.message}`; }
    if (root.contains(list)) setTimeout(watchProposals, 3000);
  }
  function marked(text, marks, visibleIssues, references = [], hits = []) {
    const paragraph = el("p", undefined, "review-paragraph");
    const activeMarks = marks.filter((m) => visibleIssues.has(m.issueId) && (!selectedIssue || selectedIssue === m.issueId) && issueState(m.issueId) === "pending");
    const refs = references.filter((r) => Number.isInteger(r.offset) && r.offset >= 0 && r.offset <= text.length);
    const points = [...new Set([0, text.length, ...activeMarks.flatMap((m) => [m.start, m.end]), ...hits.flatMap((m) => [m.start, m.end]), ...refs.flatMap((r) => [r.offset, r.offset + (r.length || 0)])])].sort((a, b) => a - b);
    const insert = (at) => {
      for (const r of refs.filter((r) => r.offset === at)) {
        const sup = el("sup", undefined, "author-note-callout");
        if (r.inlineNote === false) { sup.textContent = `[${r.label}]`; paragraph.append(sup); continue; }
        const link = button(`[${r.label}]`, `作者原注 ${r.label}：${r.note.translation?.slice(0, 80) || r.note.source.slice(0, 80)}`, () => {
          root.querySelector(`[data-unit="${r.unitId}"] [data-note="${r.noteId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        }); sup.append(link); paragraph.append(sup);
      }
    };
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      insert(a);
      if (refs.some((r) => r.length && a >= r.offset && b <= r.offset + r.length)) continue;
      const covered = activeMarks.filter((m) => m.start <= a && m.end >= b);
      const hit = hits.find((m) => m.start <= a && m.end >= b);
      if (hit) {
        const mark = el("mark", text.slice(a, b), hit.current ? "search-hit search-current" : "search-hit");
        mark.title = "检索命中"; paragraph.append(mark);
      } else if (!covered.length) paragraph.append(document.createTextNode(text.slice(a, b)));
      else {
        const exact = covered.some((m) => m.exact);
        const mark = el("mark", text.slice(a, b), exact ? "quote-mark" : "paragraph-mark");
        mark.tabIndex = 0; mark.setAttribute("role", "button");
        mark.title = exact ? "查看此处疑点" : "报告未给出可匹配的短语，整段待核";
        const show = () => { selectedIssue = (covered.find((m) => m.exact) || covered[0]).issueId; render(); const row = root.querySelector(`[data-issue="${selectedIssue}"]`); const details = row?.closest("details"); if (details) details.open = true; row?.querySelector("button")?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
        mark.onclick = show; mark.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(); } };
        paragraph.append(mark);
      }
    }
    insert(text.length);
    return paragraph;
  }

  function paragraphViews(unit) {
    const references = (unit.authorNotes || []).map((r) => {
      const at = r.targetQuote ? unit.target.indexOf(r.targetQuote) : -1;
      const targetOffset = at >= 0 && unit.target.indexOf(r.targetQuote, at + 1) < 0 ? at + r.targetQuote.length : null;
      const suffix = targetOffset === null ? "" : unit.target.slice(targetOffset);
      const existingMarkerLength = suffix.startsWith(`[^${r.label}]`) ? r.label.length + 3 : suffix.startsWith(`[${r.label}]`) ? r.label.length + 2
        : suffix.startsWith(r.label) && !/\d/.test(suffix[r.label.length] || "") ? r.label.length : 0;
      return { ...r, targetOffset, existingMarker: existingMarkerLength > 0, existingMarkerLength };
    });
    let previous = 0;
    let parts = (unit.paragraphMap?.paragraphs || []).map((p) => {
      const at = unit.target.indexOf(p.targetQuote);
      const end = at >= 0 && unit.target.indexOf(p.targetQuote, at + 1) < 0 ? at + p.targetQuote.length : -1;
      const result = { ...p, targetStart: previous, targetEnd: end }; previous = end; return result;
    });
    if (!parts.length || parts.some((p) => p.targetEnd <= p.targetStart) || /\S/.test(unit.target.slice(parts.at(-1).targetEnd))) {
      parts = [{ id: "p1", sourceStart: 0, sourceEnd: unit.source.length, targetStart: 0, targetEnd: unit.target.length }];
    }
    return parts.map((p) => ({ ...p, source: unit.source.slice(p.sourceStart, p.sourceEnd), target: unit.target.slice(p.targetStart, p.targetEnd),
      references: references.filter((r) => r.sourceStart >= p.sourceStart && r.sourceStart < p.sourceEnd),
      translatorNotes: (unit.translatorNotes || []).filter((n) => n.paragraphId === p.id || parts.length === 1) }));
  }

  async function saveAnnotation(key, data) {
    if (editing) return;
    editing = true; render();
    try {
      if (options.onAnnotationEdit) {
        const result = await options.onAnnotationEdit({ version: model.version, revision: model.annotations?.revision || 0, ...data });
        accept(result);
      } else {
        const next = structuredClone(model);
        if (data.kind === "author") {
          for (const u of next.units) for (const r of u.authorNotes || []) if (r.noteId === data.noteId) r.note = { ...r.note, source: data.source, translation: data.translation };
        } else {
          const u = next.units.find((u) => u.id === data.unitId); u.translatorNotes ||= [];
          const at = u.translatorNotes.findIndex((n) => n.id === data.noteId);
          if (data.delete) u.translatorNotes.splice(at, 1);
          else { const note = { id: data.noteId || crypto.randomUUID(), unitId: u.id, paragraphId: data.paragraphId, text: data.text }; if (at < 0) u.translatorNotes.push(note); else u.translatorNotes[at] = note; }
        }
        next.annotations = { ...next.annotations, revision: (next.annotations?.revision || 0) + 1 };
        localStorage.setItem(offlineKey, JSON.stringify({ edits, model: next })); model = next;
      }
      delete annotationDrafts[key]; persistAnnotationDrafts();
      status.textContent = options.onAnnotationEdit ? "注释已保存，段后注释与下载稿已同步更新。正文未改动。" : "注释已保存到此浏览器，可下载修订译文稿。";
    } catch (e) { status.textContent = `注释未保存：${e.message}`; }
    finally { editing = false; render(); }
  }

  function annotationEditor(key, value) {
    const draft = annotationDrafts[key];
    if (!draft) return el("span");
    const form = el("div", undefined, "annotation-editor");
    const fields = draft.kind === "author" ? [["source", "作者原注原文"], ["translation", "作者原注译文"]] : [["text", "新增或修改译注"]];
    for (const [name, title] of fields) {
      const label = el("label", title), input = el("textarea"); input.setAttribute("aria-label", title);
      input.value = draft[name] || ""; input.rows = 4; input.maxLength = 50000; input.disabled = editing;
      input.oninput = () => { draft[name] = input.value; persistAnnotationDrafts(); apply.disabled = editing || fields.some(([f]) => !draft[f]?.trim()); };
      label.append(input); form.append(label);
    }
    const actions = el("div", undefined, "review-edit-actions");
    const apply = button("保存注释", "保存原注或译注", () => saveAnnotation(key, { ...value, ...draft }));
    apply.disabled = editing || fields.some(([f]) => !draft[f]?.trim());
    const cancel = button("取消", "放弃本条注释草稿", () => { delete annotationDrafts[key]; persistAnnotationDrafts(); render(); }); cancel.disabled = editing;
    actions.append(apply, cancel); form.append(actions); return form;
  }

  function paragraphNotes(unit, part) {
    const wrap = el("section", undefined, "paragraph-notes"); wrap.setAttribute("aria-label", "段后注释");
    const open = (key, draft) => { annotationDrafts[key] ||= draft; persistAnnotationDrafts(); render(); };
    for (const r of [...new Map(part.references.filter((r) => r.inlineNote !== false).map((r) => [r.noteId, r])).values()]) {
      const row = el("div", undefined, "author-note"); row.dataset.note = r.noteId;
      const source = marked(r.note.source, [], new Set(), [], noteHits(unit, r.noteId, "source")); source.className += " note-source";
      const translation = marked(r.note.translation || "原注待翻译", [], new Set(), [], noteHits(unit, r.noteId, "target")); translation.className += " note-translation";
      row.append(el("strong", `作者原注 ${r.label}`), source, translation);
      if (r.note.page && options.pdfUrl) { const link = el("a", `核对原注 · PDF ${r.note.page}`); link.href = `${options.pdfUrl}#page=${r.note.page}`; link.target = "_blank"; link.rel = "noopener"; row.append(link); }
      const key = `author:${r.noteId}`;
      row.append(button("编辑原注", "修改此条作者原注及其译文", () => open(key, { kind: "author", noteId: r.noteId, source: r.note.source, translation: r.note.translation })), annotationEditor(key, {}));
      wrap.append(row);
    }
    for (const [i, note] of part.translatorNotes.entries()) {
      const row = el("div", undefined, "translator-note"), key = `translator:${note.id}`;
      row.append(el("strong", `译注 ${i + 1}`), marked(note.text, [], new Set(), [], noteHits(unit, note.id)), button("编辑译注", "修改此条译注", () => open(key, { kind: "translator", noteId: note.id, unitId: unit.id, paragraphId: part.id, text: note.text })),
        button("×", "删除此条译注", () => saveAnnotation(key, { kind: "translator", noteId: note.id, unitId: unit.id, paragraphId: part.id, delete: true })), annotationEditor(key, {}));
      wrap.append(row);
    }
    const key = `new-translator:${unit.id}:${part.id}`;
    wrap.append(button("＋ 译注", "为本自然段增加译者注释", () => open(key, { kind: "translator", unitId: unit.id, paragraphId: part.id, text: "" })), annotationEditor(key, {}));
    return wrap;
  }
  function issueRow(q, unit) {
    const row = el("div", undefined, `review-issue ${q.severity}`); row.dataset.issue = q.id;
    const head = el("div", undefined, "review-issue-heading");
    const label = { blocking: "重点核查", warning: "警告", note: "说明" }[q.severity] || q.severity;
    const focus = button(`${label} · ${q.category}`, "定位这项疑点", () => { selectedIssue = selectedIssue === q.id ? null : q.id; render(); });
    focus.className = "review-issue-focus"; focus.setAttribute("aria-pressed", String(selectedIssue === q.id));
    const decision = select("处理结果", [["pending", "待核查"], ["reviewed", "已核查"], ["dismissed", "无需修改"]], issueState(q.id), (v) => {
      state.issues[q.id] = { ...state.issues[q.id], status: v }; selectedIssue = null; save(); render();
    });
    head.append(focus, decision); row.append(head, el("p", q.description), el("p", `建议：${q.recommendation}`, "review-recommendation"));
    if (unit.qa?.state === "stale" || q.stale) row.prepend(el("p", `历史意见 · 依据修订 ${unit.qa?.basisRevision || 0} · 当前译文已修改，结论待重检`, "review-qa-stale"));
    const exact = [...unit.sourceMarks, ...unit.targetMarks].some((m) => m.issueId === q.id && m.exact);
    if (!exact && q.severity !== "note") row.append(el("p", "范围：整段待核（报告没有可直接匹配的引文）", "review-location"));
    if (q.metadataOnly) row.append(el("p", "此项只涉及已移除的排版记录，不计入正文待核。", "review-location"));
    const note = el("textarea"); note.rows = 2; note.placeholder = "填写核查依据或修改意见"; note.setAttribute("aria-label", "核查记录"); note.value = state.issues[q.id]?.note || "";
    const feedback = el("p", note.value ? (savedNotes.get(q.id) === note.value ? "意见已保存。" : "意见尚未保存。") : "", "review-note-status"); feedback.setAttribute("role", "status");
    note.oninput = () => { state.issues[q.id] = { ...state.issues[q.id], status: issueState(q.id), note: note.value }; feedback.textContent = "意见尚未保存。"; };
    note.onchange = () => save(feedback); row.append(note);
    const actions = el("div", undefined, "review-edit-actions");
    actions.append(button("保存意见", "保存本条核查意见", () => save(feedback)));
    if (!unit.artifact && options.onPropose) {
      const ai = button("AI 按建议修订", "按质检建议及填写的意见生成本段修订草稿", () => generate(unit, q, note.value, feedback));
      ai.disabled = proposals.some((p) => ["queued", "running"].includes(p.state)); actions.append(ai);
    }
    row.append(actions, feedback);
    const proposal = [...proposals].reverse().find((p) => p.unitId === unit.id && p.issueId === q.id);
    if (proposal) {
      const preview = el("div", undefined, "review-proposal");
      if (["queued", "running"].includes(proposal.state)) preview.append(el("p", "AI 正在生成草稿，原译文尚未改动。", "review-note-status"));
      else if (proposal.state === "failed") preview.append(el("p", `AI 修订失败：${proposal.error}`, "review-edit-conflict"));
      else {
        const applied = edits.history.some((h) => h.proposalId === proposal.id);
        const details = el("details"); details.open = !applied;
        details.append(el("summary", applied ? "已应用的 AI 草稿" : "AI 草稿 · 尚未应用"), el("p", proposal.translation, "review-paragraph"), el("p", proposal.explanation, "review-recommendation"));
        if (proposal.note) details.append(el("p", `本次意见：${proposal.note}`, "review-location"));
        if (!applied && proposal.before === unit.target) details.append(button("编辑并应用此草稿", "将 AI 草稿放入译文编辑框", () => {
          draftFor(unit, { target: proposal.translation, proposalId: proposal.id, explanation: proposal.explanation });
          root.querySelector(`[data-unit="${unit.id}"] .review-editor textarea`)?.focus();
        }));
        else if (!applied) details.append(el("p", "当前译文已变化，此草稿已过期，请重新生成。", "review-edit-conflict"));
        preview.append(details);
      }
      row.append(preview);
    }
    if (q.blockIds.length > 1) {
      const related = el("div", undefined, "review-related");
      for (const id of q.blockIds.filter((id) => id !== unit.blockId)) {
        const destination = model.units.find((u) => u.blockId === id);
        if (destination) related.append(button(`关联段落 · PDF ${destination.page || ""}`, "显示关联段落", () => {
          scope = "all"; scopeSelect.querySelector("select").value = "all"; query = ""; search.value = ""; pendingOnly = false; pending.checked = false; filter = "all"; severitySelect.querySelector("select").value = "all";
          const all = filteredUnits(); page = Math.floor(all.findIndex((u) => u.id === destination.id) / pageSize); selectedIssue = q.id; render();
          root.querySelector(`[data-unit="${destination.id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
        }));
      }
      row.append(related);
    }
    return row;
  }
  function filteredUnits() {
    return model.units.filter((u) => (scope === "all" || unitScope(u) === scope)
      && (!qaMode || (qaFilter === "all" || u.qa?.state === qaFilter) && (matching(u).length || u.qa?.state === "stale"))
      && (!query || reviewMatches(u, query, searchField, wholeWord).length));
  }
  const hitKey = (h) => `${h.unitId}:${h.field}:${h.noteId || ""}:${h.side || ""}:${h.start}`;
  let hits = [];
  function unitHits(unit, field) {
    return hits.filter((h) => h.unitId === unit.id && h.field === field).map((h) => ({ ...h, current: hitKey(h) === (hits[selectedHit] && hitKey(hits[selectedHit])) }));
  }
  function noteHits(unit, noteId, side) { return unitHits(unit, "notes").filter((h) => h.noteId === noteId && h.side === side); }
  function goHit(index) {
    if (!hits.length) return;
    selectedHit = (index + hits.length) % hits.length;
    page = Math.floor(filteredUnits().findIndex((u) => u.id === hits[selectedHit].unitId) / pageSize);
    render(); root.querySelector(".search-current")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  function render() {
    termsButton.disabled = !query;
    const bodyIds = new Set(model.units.filter((u) => unitScope(u) === "body").flatMap((u) => u.issueIds));
    const pendingCount = (ids) => [...ids].filter((id) => issues.get(id)?.severity !== "note" && !issues.get(id)?.stale && issueState(id) === "pending").length;
    const auxIds = new Set(model.units.filter((u) => unitScope(u) === "auxiliary").flatMap((u) => u.issueIds));
    const filtered = filteredUnits();
    hits = query ? filtered.flatMap((u) => reviewMatches(u, query, searchField, wholeWord)) : [];
    selectedHit = Math.max(0, Math.min(selectedHit, hits.length - 1));
    if (selectedIssue && !filtered.some((u) => matching(u).some((q) => q.id === selectedIssue))) selectedIssue = null;
    page = Math.max(0, Math.min(page, Math.ceil(filtered.length / pageSize) - 1));
    count.textContent = qaMode ? `当前稿修订 ${edits.revision} · 修改后待重检 ${model.units.filter((u) => !u.artifact && u.qa?.state === "stale").length} 段 · 正文待核 ${pendingCount(bodyIds)} 项 · 当前 ${filtered.length} 段`
      : `全稿修订 ${edits.revision} · 当前 ${filtered.length} 段${query ? ` · 命中 ${hits.length} 处` : ""}${model.terminology?.entries.length ? ` · 作者释义 ${model.terminology.entries.length} 条` : ""}`;
    const wasOpen = concordance.open; concordance.replaceChildren(); concordance.hidden = !query;
    if (query) {
      concordance.append(el("summary", `“${query}” · ${hits.length} 处 · ${filtered.length} 段`)); concordance.open = wasOpen;
      const navigation = el("div", undefined, "review-edit-actions");
      navigation.append(button("↑", "上一处术语", () => goHit(selectedHit - 1)), el("span", `${hits.length ? selectedHit + 1 : 0} / ${hits.length}`), button("↓", "下一处术语", () => goHit(selectedHit + 1)));
      concordance.append(navigation);
      for (const [i, h] of hits.entries()) {
        const unit = model.units.find((u) => u.id === h.unitId);
        const label = { source: "原文", target: "译文", notes: "注释" }[h.field];
        concordance.append(button(`${i + 1}. ${label} · PDF ${unit.page || ""} · ${h.text.slice(Math.max(0, h.start - 35), Math.min(h.text.length, h.end + 60))}`,
          `定位第 ${i + 1} 处`, () => goHit(i)));
      }
      const definitions = (model.terminology?.entries || []).filter((e) => e.term.toLowerCase().includes(query.toLowerCase()) || query.toLowerCase().includes(e.term.toLowerCase()));
      for (const entry of definitions) {
        const definition = el("div", undefined, "author-definition");
        definition.append(el("strong", `作者释义：${entry.term} · ${entry.page ? `PDF ${entry.page}` : entry.section}`), el("p", entry.definition)); concordance.append(definition);
      }
    }
    list.replaceChildren();
    if (!filtered.length) list.append(el("p", "没有符合当前筛选条件的段落。", "review-empty"));
    for (const unit of filtered.slice(page * pageSize, (page + 1) * pageSize)) {
      const article = el("article", undefined, "review-unit"); article.dataset.unit = unit.id;
      const meta = el("div", undefined, "review-unit-meta");
      const pages = unit.pages?.length ? unit.pages : unit.page ? [unit.page] : [];
      meta.append(el("span", `${unit.section}${pages.length ? ` · PDF 第 ${pages.join("、")} 页` : ""}${unit.parts > 1 ? ` · ${unit.part}/${unit.parts}` : ""}`));
      if (unit.annotationNeedsAlignment) meta.append(el("span", "正文已改动 · 部分注释位置待重新整理", "review-qa-stale"));
      if (!unit.artifact && qaMode) {
        meta.append(el("span", unit.qa?.state === "stale" ? "人工已修改 · 旧质检待复核" : `质检依据：修订 ${unit.qa?.basisRevision || 0}`, unit.qa?.state === "stale" ? "review-qa-stale" : "review-location"));
        if (options.onRecheck) meta.append(button("重新质检本段", "按当前译文重新质检本段", () => recheck([unit.id])));
      }
      if (options.pdfUrl) for (const pageNumber of pages) { const link = el("a", pages.length > 1 ? `核对第 ${pageNumber} 页` : "核对原页"); link.href = `${options.pdfUrl}#page=${pageNumber}`; link.target = "_blank"; link.rel = "noopener"; meta.append(link); }
      if (unit.blockId) meta.append(select("内容归类", [["body", "正文"], ["auxiliary", "辅助内容"]], unitScope(unit), (v) => { state.scopes[unit.blockId] = v; save(); render(); }));
      const visibleIssues = new Set((qaMode && unit.qa?.state !== "stale" ? matching(unit) : []).map((q) => q.id));
      const prose = el("div", undefined, "annotated-prose");
      const shifted = (marks, start, end) => marks.filter((m) => m.end > start && m.start < end).map((m) => ({ ...m, start: Math.max(start, m.start) - start, end: Math.min(end, m.end) - start }));
      for (const part of paragraphViews(unit)) {
        const sourceRefs = part.references.map((r) => ({ ...r, offset: r.sourceStart - part.sourceStart, length: r.sourceEnd - r.sourceStart }));
        const targetRefs = part.references.map((r) => ({ ...r, offset: r.targetOffset === null ? null : r.targetOffset - part.targetStart,
          length: r.existingMarkerLength || 0 }));
        const source = marked(part.source, shifted(unit.sourceMarks, part.sourceStart, part.sourceEnd), visibleIssues, sourceRefs,
          shifted(unitHits(unit, "source"), part.sourceStart, part.sourceEnd)); source.classList.add("review-source"); source.lang = "en";
        const target = marked(part.target, shifted(unit.targetMarks, part.targetStart, part.targetEnd), visibleIssues, targetRefs,
          shifted(unitHits(unit, "target"), part.targetStart, part.targetEnd)); target.classList.add("review-target"); target.lang = "zh-CN";
        const section = el("div", undefined, "natural-paragraph"); section.dataset.paragraph = part.id;
        section.append(source, target); if (!unit.artifact) section.append(paragraphNotes(unit, part)); prose.append(section);
      }
      const notes = el("div", undefined, "review-explanation");
      const own = qaMode ? matching(unit) : [], important = own.filter((q) => q.severity !== "note"), informational = own.filter((q) => q.severity === "note");
      for (const q of important) notes.append(issueRow(q, unit));
      if (informational.length) {
        const details = el("details", undefined, "review-informational"); details.append(el("summary", `提示与译者说明 ${informational.length} 项`));
        for (const q of informational) details.append(issueRow(q, unit)); notes.append(details);
      }
      if (qaMode && !own.length) notes.append(el("p", unit.qa?.state === "stale" ? "当前人工修订尚未重新质检。" : "未发现符合当前筛选条件的疑点。", "review-clear"));
      if (qaMode && unit.qa?.state === "stale") {
        const basis = el("details"); basis.append(el("summary", `对照旧质检所依据的译文 · 修订 ${unit.qa.basisRevision}`), el("p", unit.qa.basisTarget, "review-paragraph")); notes.append(basis);
      }
      const context = el("details", undefined, "review-context"); context.append(el("summary", "前后文"));
      context.open = openContexts.has(unit.id);
      context.ontoggle = () => { if (context.isConnected) { if (context.open) openContexts.add(unit.id); else openContexts.delete(unit.id); } };
      const at = model.units.findIndex((u) => u.id === unit.id);
      for (const n of [at - 1, at + 1]) {
        const neighbor = model.units[n]; if (!neighbor || neighbor.artifact) continue;
        const part = el("div"); part.dataset.contextUnit = neighbor.id;
        const label = n < at ? "上一段" : "下一段";
        part.setAttribute("aria-label", `${label}译文`);
        part.append(el("small", `${label} · PDF ${(neighbor.pages || [neighbor.page]).filter(Boolean).join("、")}`), el("p", neighbor.source), el("p", neighbor.target));
        part.append(editor(neighbor)); context.append(part);
      }
      notes.append(context);
      article.append(meta, prose); if (!unit.artifact) article.append(editor(unit)); article.append(notes); list.append(article);
    }
    pager.replaceChildren();
    const prev = button("←", "上一组段落", () => { page--; selectedIssue = null; render(); root.scrollIntoView({ block: "start" }); }); prev.disabled = page === 0;
    const next = button("→", "下一组段落", () => { page++; selectedIssue = null; render(); root.scrollIntoView({ block: "start" }); }); next.disabled = (page + 1) * pageSize >= filtered.length;
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const jump = el("input"); jump.type = "number"; jump.min = "1"; jump.max = String(pages); jump.value = String(page + 1); jump.setAttribute("aria-label", "跳转到组");
    jump.onchange = () => { page = Math.max(0, Math.min(pages - 1, Math.trunc(Number(jump.value) || 1) - 1)); render(); };
    pager.append(prev, jump, el("span", `/ ${pages} 组`), next);
  }
  render();
  if (options.onProposals) setTimeout(watchProposals, 3000);
  if (options.onSnapshot) setTimeout(watchSnapshot, 4000);
}
