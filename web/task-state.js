// A saved worker record can outlive the worker and a later CLI continuation.
export function currentTask(state, project) {
  const task = state?.task;
  if (!project || task?.projectId !== project.id) return null;
  if (!task.active && task.type === "translation" && ["completed", "qa_failed"].includes(project.status)) return null;
  const owner = state.active;
  if (owner?.projectId === project.id && owner.pid && owner.pid !== task.pid) return null;
  if (!task.active && Date.parse(project.translation?.request?.startedAt) > Date.parse(task.updatedAt || task.createdAt)) return null;
  return task;
}

export function translationControl(state, project, { busy = false, sourceReady = null } = {}) {
  const task = currentTask(state, project);
  const running = state.active?.projectId === project.id;
  const label = running ? "翻译与质检进行中…"
    : project.status === "source_review_required" ? "批准原文并翻译"
      : project.status === "translation_paused" || task?.state === "paused" ? "继续翻译与质检"
        : ["translation_failed", "qa_failed", "translating"].includes(project.status) ? "重试翻译与质检" : "开始翻译";
  const reason = busy ? "正在提交操作，请稍候。"
    : state.active ? running ? "当前任务正在处理，已完成的译文会持续保存；中断后可从断点重试。" : "另一个任务正在处理，请等待完成。"
      : !state.config.translationReady ? "请先配置翻译服务密钥。"
        : project.status === "source_review_required" && sourceReady !== project.id ? "正在读取原文，请稍候。"
          : !["source_review_required", "source_approved", "translation_failed", "translation_paused", "qa_failed", "translating"].includes(project.status) ? "当前状态无需启动翻译。" : "";
  return { label, disabled: Boolean(reason), reason };
}
