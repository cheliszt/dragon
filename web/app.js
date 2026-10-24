import { previewPdf, showPdfPage } from "./pdf-preview.js";
import { mountReview } from "./review.js";
import { mountSourceReview } from "./source-review.js";
import { currentTask, translationControl } from "./task-state.js";

const $ = (id) => document.getElementById(id);
const statusNames = {
  source_inspecting: "检测文字层中", source_failed: "原文获取失败",
  ocr_submitting: "提交识别中", ocr_running: "识别中", source_review_required: "待校对",
  source_approved: "原文已批准", translating: "翻译与质检中", completed: "已完成",
  ocr_failed: "识别失败", translation_failed: "等待恢复", translation_paused: "翻译已暂停", source_paused: "原文获取已暂停", qa_failed: "质检待处理"
};
let state = null;
let selected = null;
let file = null;
let dirty = false;
let loadedSource = null;
let sourceReady = null;
let tab = "source";
let busy = false;
let sourceVersion = 0;
let outputVersion = 0;
let followUpload = false;
let historyKey = "";
let languageProject = null;
const languageNames = { en: "英语", "zh-Hans": "简体中文", "zh-Hant": "繁体中文", ja: "日语", ko: "韩语", pinyin: "汉语拼音" };
function mountLanguages(id) {
  const root = $(id), fieldset = document.createElement("fieldset"), legend = document.createElement("legend");
  legend.textContent = "材料包含的源语言（可多选）"; fieldset.append(legend);
  for (const [code, name] of Object.entries(languageNames)) {
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.value = code; input.checked = code === "en";
    label.append(input, name); fieldset.append(label);
  }
  const label = document.createElement("label"), select = document.createElement("select");
  select.setAttribute("aria-label", id === "upload-languages" ? "新文献目标语言" : "当前文献目标语言");
  for (const code of ["zh-Hans", "en"]) { const option = document.createElement("option"); option.value = code; option.textContent = languageNames[code]; select.append(option); }
  label.append("目标语言 ", select); root.append(fieldset, label);
}
function getLanguages(id) {
  const root = $(id);
  const sourceLanguages = [...root.querySelectorAll("input:checked")].map((x) => x.value);
  if (!sourceLanguages.length) throw new Error("请至少选择一种材料包含的源语言。");
  return { sourceLanguages, targetLanguage: root.querySelector("select").value };
}
mountLanguages("upload-languages"); mountLanguages("project-languages");
const sourceReview = mountSourceReview({ editor: $("source-text"), onPage: showPdfPage,
  onChange: (text) => { dirty = true; message(text); render(); } });

function message(text = "", error = false) {
  $("error").hidden = true;
  $("notice").hidden = true;
  if (text) {
    const element = $(error ? "error" : "notice");
    element.textContent = text;
    element.hidden = false;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), ...options, headers: { "X-Local-Request": "1", ...options.headers } });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return response;
}

const projectUrl = (action, id = selected) => `/api/projects/${encodeURIComponent(id)}/${action}`;
const fileUrl = (kind, download = false) => `${projectUrl("file")}?kind=${kind}${download ? "&download=1" : ""}`;
const current = () => state?.projects.find((item) => item.id === selected);

function selectFile(next) {
  if (!next) return;
  if (!/\.pdf$/i.test(next.name)) return message("请选择 PDF 文件。", true);
  if (next.size > 50 * 1024 * 1024) return message("PDF 超过 50 MB，请先拆分。", true);
  if (!next.size) return message("文件为空。", true);
  file = next;
  $("file-name").textContent = file.name;
  $("file-size").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  message();
  render();
}

function chooseProject(id) {
  if (id === selected) return;
  if (busy) return;
  if (dirty && !confirm("校对内容尚未保存，是否放弃修改并切换文献？")) return;
  selected = id;
  dirty = false;
  loadedSource = null;
  sourceReady = null;
  sourceVersion += 1;
  outputVersion += 1;
  $("source-text").value = "";
  tab = "source";
  localStorage.setItem("translation-project", id);
  render();
}

async function loadSource(project) {
  const key = `${project.id}:${project.sourceVersion || ""}`;
  if (!project.hasSource || loadedSource === key || dirty) return;
  const version = ++sourceVersion;
  loadedSource = key;
  try {
    const result = await (await request(projectUrl("source", project.id))).json();
    if (version !== sourceVersion || selected !== project.id) return;
    $("source-text").value = result.text;
    sourceReady = project.id;
    render();
  } catch (error) {
    if (version === sourceVersion) { loadedSource = null; message(error.message, true); }
  }
}

function render() {
  const locked = Boolean(state?.active) || busy;
  const mode = document.querySelector('input[name="source-mode"]:checked').value;
  $("upload").disabled = !file || locked || !state || (mode === "ocr" && !state.config.paddleReady);
  $("upload").textContent = busy ? "处理中…" : "开始处理";
  document.querySelectorAll('input[name="source-mode"]').forEach((input) => { input.disabled = locked; });
  $("upload-languages").querySelectorAll("input,select").forEach((input) => { input.disabled = locked; });
  if (!state) return;
  const { config, projects, active } = state;
  $("ocr-config").textContent = `识别服务：${config.paddleReady ? "令牌已配置" : "未配置令牌"}`;
  $("translation-config").textContent = `翻译服务：${config.translationReady ? config.model : "未配置密钥"}`;
  $("provider").textContent = `翻译 · ${config.provider}`;
  $("project-count").textContent = projects.length;
  $("history-empty").hidden = projects.length > 0;
  const key = JSON.stringify([selected, projects.map((p) => [p.id, p.status])]);
  if (key !== historyKey) {
    historyKey = key;
    $("projects").replaceChildren(...projects.map((p) => {
      const button = document.createElement("button");
      button.className = `project${selected === p.id ? " selected" : ""}`;
      if (selected === p.id) button.setAttribute("aria-current", "page");
      const name = document.createElement("strong");
      name.textContent = p.name;
      const status = document.createElement("span");
      status.textContent = `${statusNames[p.status] || p.status} · ${new Date(p.createdAt).toLocaleDateString("zh-CN")}`;
      button.append(name, status);
      button.onclick = () => chooseProject(p.id);
      return button;
    }));
  }
  const p = current();
  const task = currentTask(state, p);
  $("empty").hidden = Boolean(p);
  $("detail").hidden = !p;
  if (!p) return;
  if (languageProject !== p.id || p.languagesLocked) {
    languageProject = p.id;
    const languages = p.languages || { sourceLanguages: ["en"], targetLanguage: "zh-Hans" };
    $("project-languages").querySelectorAll("input").forEach((input) => { input.checked = languages.sourceLanguages.includes(input.value); });
    $("project-languages").querySelector("select").value = languages.targetLanguage;
  }
  $("project-languages").querySelectorAll("input,select").forEach((input) => { input.disabled = locked || p.languagesLocked; });
  $("target-language-label").textContent = `输出语言 · ${languageNames[p.languages?.targetLanguage || "zh-Hans"]}`;
  $("project-name").textContent = p.name;
  $("project-id").textContent = p.id;
  $("project-status").textContent = task?.state === "paused" ? "已暂停" : statusNames[p.status] || p.status;
  $("project-status").className = `badge${p.status.endsWith("failed") ? " warning" : ""}`;
  const stage = p.status === "completed" ? 4 : p.status.startsWith("ocr") || ["source_inspecting", "source_failed", "source_paused"].includes(p.status) ? 1 : p.status === "source_review_required" ? 2 : 3;
  document.querySelectorAll(".steps li").forEach((li, index) => li.classList.toggle("reached", index < stage));
  let progress = "";
  if (p.status === "source_inspecting") progress = `正在本地检测文字层：${p.preparation?.progress?.extractedPages || 0} / ${p.preparation?.progress?.totalPages || "—"} 页`;
  if (p.status === "ocr_running") progress = p.progress?.totalPages ? `已识别 ${p.progress.extractedPages || 0} / ${p.progress.totalPages} 页` : "正在等待云端识别结果…";
  if (p.status === "ocr_submitting") progress = "正在向 PaddleOCR 提交文献…";
  if (["translating", "translation_failed", "translation_paused"].includes(p.status)) progress = p.translation?.translated === undefined ? `已完成 ${p.translation?.done || 0} / ${p.translation?.total || "—"} 个翻译片段`
    : `语言检测 ${p.translation.detected || 0}/${p.translation.total} · 译文 ${p.translation.translated}/${p.translation.total} · 质检 ${p.translation.reviewed || 0}/${p.translation.total}`;
  if (["source_inspecting", "ocr_running", "ocr_submitting", "translating"].includes(p.status) && active?.projectId !== p.id) progress = "任务已中断，已保存完成的步骤，可继续处理。";
  if (p.status === "source_review_required") progress = "等待原文校对与批准";
  if (p.status === "completed") progress = "初译已完成";
  if (p.status === "qa_failed") progress = "初译已完成，初次质检有待核事项";
  $("job-progress").textContent = progress;
  const requestProgress = p.translation?.request;
  let detail = "";
  if (active?.projectId === p.id && requestProgress?.phase) {
    detail = `${requestProgress.phase === "language-detection" ? "语言检测与句段分析" : requestProgress.phase === "qa" ? "质检" : "翻译"}第 ${requestProgress.chunk} 组`;
    if (requestProgress.state === "receiving") detail += ` · 已接收 ${requestProgress.receivedCharacters || 0} 字符`;
    if (requestProgress.state === "requesting") detail += ` · 请求 ${requestProgress.attempt}/${requestProgress.maxAttempts}`;
    if (requestProgress.state === "retry_wait") detail += ` · 等待重试，${Math.max(0, Math.ceil((Date.parse(requestProgress.nextRetryAt) - Date.now()) / 1000))} 秒`;
  }
  if (task?.state === "retry_wait") detail = `服务暂不可用，${Math.max(0, Math.ceil((Date.parse(task.nextRetryAt) - Date.now()) / 1000))} 秒后从断点恢复`;
  if (task?.state === "paused") detail = "已暂停，完成的结果已保存";
  if (task?.state === "needs_attention") detail = task.error || "需要处理后继续";
  if (task?.type === "annotations" && task.active) {
    const p = task.progress;
    detail = p?.phase === "note-translation" ? `正在补译作者原注 · 剩余 ${p.remaining} 条`
      : p?.phase === "retry-wait" ? "注释服务暂时繁忙，正在等待重试"
        : `正在整理段后注释 · ${p?.completed || 0}/${p?.total || "…"} 段`;
  }
  if (task?.type === "review" && task.active) detail = `质检当前稿 · 修订 ${task.progress?.editRevision ?? "…"} · ${task.progress?.completed || 0}/${task.progress?.total || "…"} 段`;
  if (task?.pauseRequested && task.active) detail = "将在当前请求保存后暂停";
  if (active?.projectId === p.id && p.terminologyProgress && p.terminologyProgress.phase !== "ready") {
    const terms = p.terminologyProgress;
    detail = terms.phase === "terminology-consolidation" ? "原文通读完成，正在确定全书固定术语译法" : `译前通读与术语分析 ${terms.completed}/${terms.total} 批`;
  }
  if (active?.projectId === p.id && !task?.active) detail += `${detail ? " · " : ""}翻译正在继续，已完成的译文持续保存`;
  $("task-detail").textContent = detail;
  $("pause-task").hidden = !task?.active;
  $("pause-task").disabled = Boolean(task?.pauseRequested) || busy;
  $("resume-source").hidden = !p.canResumeSource || Boolean(active);
  $("resume-source").disabled = busy;
  $("task-actions").hidden = !detail && $("pause-task").hidden && $("resume-source").hidden;
  const prep = p.preparation;
  $("source-method").hidden = !prep?.method;
  $("source-method").textContent = prep?.method === "text"
    ? `原文来源：本地文字提取 · ${prep.textPages}/${prep.inspectedPages} 页含文字 · 实质文字覆盖 ${Math.round((prep.coverage || 0) * 100)}%${prep.reviewPages?.length ? ` · 待核对 PDF 页：${prep.reviewPages.join("、")}` : ""}`
    : "原文来源：云端 OCR";
  const error = active?.projectId === p.id || task?.state === "paused" || p.status.endsWith("_paused") ? "" : state.lastError?.projectId === p.id ? state.lastError.message : p.error;
  $("project-error").textContent = error || "";
  $("project-error").hidden = !error;
  $("storage").textContent = `保存位置：${config.projectsDir}\\${p.id}`;
  const editable = p.status === "source_review_required" && sourceReady === p.id && !locked;
  $("source-text").readOnly = !editable;
  $("source-text").hidden = !p.hasSource;
  $("no-source").hidden = p.hasSource;
  $("save").disabled = !editable || !dirty;
  sourceReview.update({ id: p.id, visible: p.status === "source_review_required" && sourceReady === p.id, canEdit: editable });
  $("save-status").textContent = dirty ? "有未保存的校对" : p.normalization
    ? `连续原文已生成 · 接续 ${p.normalization.joinedBoundaries} 处 · 拼合断词 ${p.normalization.joinedWords} 处${p.normalization.removedMarkers ? ` · 移出非正文标记 ${p.normalization.removedMarkers} 处` : ""}`
    : p.hasSource ? "校对稿已保存" : "";
  const control = translationControl(state, p, { busy, sourceReady });
  $("translate").disabled = control.disabled;
  $("translate").textContent = control.label;
  $("translate").title = control.reason;
  $("source-download").hidden = !p.hasSource;
  $("source-download").href = fileUrl("source", true);
  const originalUrl = fileUrl("original");
  $("pdf-preview").hidden = !p.hasOriginal;
  $("no-pdf").hidden = p.hasOriginal;
  $("original-link").hidden = !p.hasOriginal;
  $("original-link").href = originalUrl;
  previewPdf(p.hasOriginal ? originalUrl : null);
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.disabled = button.dataset.tab !== "source" && !p.outputs.includes(button.dataset.tab);
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  });
  $("source-view").hidden = tab !== "source";
  $("output-view").hidden = tab === "source";
  loadSource(p);
}

async function refresh() {
  try {
    state = await (await request("/api/state")).json();
    $("connection").textContent = state.active ? "任务处理中" : "本地服务已连接";
    $("connection-dot").className = "dot ready";
    if (followUpload && state.active?.projectId) {
      chooseProject(state.active.projectId);
      followUpload = false;
    }
    if (!selected && state.projects.length) {
      const saved = localStorage.getItem("translation-project");
      chooseProject(state.projects.some((p) => p.id === saved) ? saved : state.projects[0].id);
    }
    if (followUpload && !state.active) {
      followUpload = false;
      if (state.lastError) message(state.lastError.message, true);
      else if (state.projects.length) chooseProject(state.projects[0].id);
    }
    render();
  } catch {
    $("connection").textContent = "连接已断开";
    $("connection-dot").className = "dot error";
    $("upload").disabled = true;
    $("save").disabled = true;
    $("translate").disabled = true;
  }
}

$("pdf").addEventListener("change", (event) => selectFile(event.target.files[0]));
document.querySelectorAll('input[name="source-mode"]').forEach((input) => input.addEventListener("change", render));
for (const type of ["dragover", "drop"]) document.addEventListener(type, (event) => event.preventDefault());
$("dropzone").addEventListener("dragover", () => $("dropzone").classList.add("dragging"));
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
$("dropzone").addEventListener("drop", (event) => { $("dropzone").classList.remove("dragging"); selectFile(event.dataTransfer.files[0]); });
$("source-text").addEventListener("input", () => { dirty = true; render(); });
window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });

$("upload").onclick = async () => {
  if (!file || busy) return;
  if (dirty && !confirm("校对内容尚未保存，是否放弃修改并识别新文献？")) return;
  dirty = false;
  busy = true;
  message();
  render();
  $("upload-progress").hidden = false;
  $("upload-meter").value = 0;
  try {
    const languages = getLanguages("upload-languages");
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.setRequestHeader("Content-Type", "application/pdf");
      xhr.setRequestHeader("X-Local-Request", "1");
      xhr.setRequestHeader("X-Translation-Languages", JSON.stringify(languages));
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.setRequestHeader("X-Source-Mode", document.querySelector('input[name="source-mode"]:checked').value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round(event.loaded / event.total * 100);
          $("upload-meter").value = percent;
          $("upload-label").textContent = `上传至本机 ${percent}%`;
        }
      };
      xhr.onload = () => {
        if (xhr.status === 202) resolve();
        else { let result; try { result = JSON.parse(xhr.responseText); } catch {} reject(new Error(result?.error || "上传失败。")); }
      };
      xhr.onerror = () => reject(new Error("上传连接中断，请确认本地服务仍在运行。"));
      xhr.send(file);
    });
    followUpload = true;
    message("文件已接收。");
    file = null;
    $("pdf").value = "";
    $("file-name").textContent = "尚未选择文献";
    $("file-size").textContent = "或将 PDF 拖入此处";
  } catch (error) { message(error.message, true); }
  finally { busy = false; $("upload-progress").hidden = true; await refresh(); }
};

async function saveSource() {
  await request(projectUrl("source"), { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: $("source-text").value });
  dirty = false;
}

$("save").onclick = async () => {
  busy = true;
  render();
  try { await saveSource(); message("校对稿已保存。"); }
  catch (error) { message(error.message, true); }
  finally { busy = false; await refresh(); }
};

$("translate").onclick = async () => {
  if (current()?.status === "source_review_required" && sourceReview.count()) {
    tab = "source";
    render();
    sourceReview.locateFirst();
    $("source-review").scrollIntoView({ block: "center", behavior: "smooth" });
    message(`还有 ${sourceReview.count()} 处待核对。请在「原文待核对清单」中定位、核对并移除标记，再批准原文。`, true);
    return;
  }
  busy = true;
  render();
  try {
    if (dirty) await saveSource();
    await request(projectUrl("translate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(getLanguages("project-languages")) });
    message("已开始翻译与质检。");
  } catch (error) { message(error.message, true); }
  finally { busy = false; await refresh(); }
};

for (const [id, action] of [["pause-task", "pause"], ["resume-source", "resume-source"]]) {
  $(id).onclick = async () => {
    busy = true; render();
    try { await request(projectUrl(action), { method: "POST" }); }
    catch (error) { message(error.message, true); }
    finally { busy = false; await refresh(); }
  };
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = async () => {
    tab = button.dataset.tab;
    render();
    const version = ++outputVersion;
    if (tab === "source") return;
    $("output-name").textContent = button.textContent;
    const interactive = ["bilingual", "qa"].includes(tab);
    const hasReader = current().outputs.includes("bilingualHtml");
    $("output-download").href = fileUrl(interactive && hasReader ? "bilingualHtml" : tab, true);
    $("output-download").textContent = interactive && hasReader ? "下载双语审阅 HTML" : "下载 Markdown";
    for (const [format, id] of [["docx", "output-word"], ["pdf", "output-pdf"]]) {
      $(id).hidden = tab !== "chinese";
      $(id).href = `${fileUrl("chinese", true)}&format=${format}`;
    }
    $("review-reader").hidden = true;
    $("output-text").hidden = false;
    $("output-text").textContent = "正在读取…";
    try {
      if (interactive && hasReader) {
        const id = selected;
        const payload = await (await request(projectUrl("review", id))).json();
        if (version !== outputVersion) return;
        let revision = payload.revision;
        const postReviewAction = async (action, data) => (await request(projectUrl(action, id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json();
        mountReview($("review-reader"), payload.model, { mode: tab, state: payload.state, edits: payload.edits,
          proposals: payload.proposals, archivedEditions: payload.archivedEditions,
          onEdit: (data) => postReviewAction("edit", data),
          onTerms: (data) => postReviewAction("terms", data),
          onAnnotationEdit: (data) => postReviewAction("annotations", data),
          onPrepareAnnotations: () => postReviewAction("prepare-annotations", {}),
          onRecheck: (data) => postReviewAction("recheck", data),
          onSnapshot: async () => (await request(projectUrl("review", id))).json(),
          onPropose: (data) => postReviewAction("proposals", data),
          onProposals: async () => (await (await request(projectUrl("proposals", id))).json()).proposals,
          pdfUrl: `${projectUrl("file", id)}?kind=original`,
          onSave: async (decisions) => {
            const result = await (await request(projectUrl("review", id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...decisions, revision }) })).json();
            revision = result.revision;
          }
        });
        $("output-text").hidden = true; $("review-reader").hidden = false;
        return;
      }
      const text = await (await request(fileUrl(tab))).text();
      if (version === outputVersion) $("output-text").textContent = text;
    } catch (error) { if (version === outputVersion) $("output-text").textContent = error.message; }
  };
});

async function poll() { await refresh(); setTimeout(poll, 2000); }
poll();
