import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, sha256 } from './utils.mjs';
import { termFile, validateTermEntry, termOccurrences, exceptionLocation, termReviewUnits } from './term-baseline.mjs';
import { reviewSnapshot, commitReviewChanges } from './review-edits.mjs';
import { withTranslationLock } from './translation-lock.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const check = (snapshot, data) => {
  if (data.version !== snapshot.model.version || data.revision !== snapshot.edits.revision || data.termRevision !== snapshot.model.termBaseline.revision
    || (data.annotationRevision || 0) !== (snapshot.model.annotations?.revision || 0))
    fail(409, '书稿或术语基线已更新，请重新预览；本次未覆盖任何人工修订。');
};

export function previewTermChanges(model, entry) {
  const variants = [...new Set(entry.variants)].filter((s) => s !== entry.translation).sort((a,b) => b.length-a.length);
  const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Include the standard term first so short variants never rewrite its suffix.
  const pattern = new RegExp([entry.translation, ...variants].sort((a,b) => b.length-a.length).map(literal).join('|'), 'gu');
  return termReviewUnits(model).filter((u) => !u.artifact && termOccurrences(u.source, entry).length).map((u) => {
    const replacements = [];
    const target = u.target.replace(pattern, (word, start) => {
      if (word === entry.translation) return word;
      replacements.push({ start, before: word, after: entry.translation });
      return entry.translation;
    });
    const protectedSource = (u.languageSegments || []).filter((s) => s.language === 'zh-Hans' || s.language === 'zh-Hant').map((s) => s.text).join('\n');
    const existingException = (u.termExceptions || []).some((e) => e.term_id === entry.id);
    const ambiguous = existingException || replacements.some((r) => protectedSource.includes(r.before) || u.source.includes(r.before)) || /\b(?:announcers?|broadcasters?)\b/i.test(u.source);
    return { unitId: u.id, ...(u.noteId ? { noteId: u.noteId } : {}), page: u.page, source: u.source, before: u.target, target, replacements,
      occurrences: termOccurrences(u.source, entry).length, selected: replacements.length > 0 && !ambiguous,
      caution: existingException ? '本段已有逐处例外说明；选择本段统一将撤销此术语的例外，请先核对。' : ambiguous ? '本段还含其他广播职业或原文中文称谓，请逐处核对后选择。' : !replacements.length && !u.target.includes(entry.translation) ? '未识别现有译法，请增加变体或单独编辑本段。' : '' };
  });
}

export async function manageTerm(dir, data, { root } = {}) {
  return withTranslationLock(dir, async () => {
    const snapshot = await reviewSnapshot(dir); check(snapshot, data);
    const baseline = snapshot.model.termBaseline;
    if (data.action === 'save') {
      const entry = { ...validateTermEntry(data.entry), origin: 'user', updatedAt: new Date().toISOString() };
      const units = termReviewUnits(snapshot.model).filter((u) => termOccurrences(u.source, entry).length);
      if (!units.length) fail(400, '全文中未找到该源语术语或所填变体，请核对拼写。');
      entry.evidence = units.slice(0, 8).map((u) => { const hit = termOccurrences(u.source, entry)[0]; return {
        blockId: u.blockId || u.id, page: u.page, quote: u.source.slice(Math.max(0,hit.start-120),hit.end+180) }; });
      const next = { ...baseline, revision: baseline.revision+1, sourceHash: snapshot.model.sourceHash,
        entries: [...baseline.entries.filter((e) => e.id !== entry.id && !termOccurrences(e.term, entry).length), entry] };
      await writeJson(path.join(dir, '00_shared/term-history', `${randomUUID()}.json`), { before: baseline, after: next });
      await writeJson(termFile(dir), next);
      return { ...(await reviewSnapshot(dir)), entry };
    }
    const entry = baseline.entries.find((e) => e.id === data.termId);
    if (!entry) fail(404, '术语不存在，请先保存标准译法。');
    if (data.action === 'preview') {
      const rows = previewTermChanges(snapshot.model, entry);
      const preview = { id: randomUUID(), version: snapshot.model.version, revision: snapshot.edits.revision,
        annotationRevision: snapshot.model.annotations?.revision || 0, termRevision: baseline.revision, termId: entry.id, rows, createdAt: new Date().toISOString() };
      preview.hash = sha256(JSON.stringify(preview));
      await writeJson(path.join(dir, '04_qa/term-previews', `${preview.id}.json`), preview);
      return preview;
    }
    if (data.action === 'apply') {
      if (!/^[a-f0-9-]{36}$/.test(data.previewId || '')) fail(400, '预览编号无效。');
      const preview = await readJson(path.join(dir, '04_qa/term-previews', `${data.previewId}.json`));
      check(snapshot, preview);
      if (preview.termId !== entry.id || preview.hash !== data.previewHash || !Array.isArray(data.unitIds) || !data.unitIds.length
        || new Set(data.unitIds).size !== data.unitIds.length) fail(400, '请选择本次预览中的段落。');
      const changes = data.unitIds.map((id) => {
        const row = preview.rows.find((r) => r.unitId === id), current = termReviewUnits(snapshot.model).find((u) => u.id === id);
        if (!row?.replacements.length || !current || row.before !== current.target) fail(409, '预览段落已变动，请重新预览。');
        return { unitId: id, ...(row.noteId ? { noteId: row.noteId } : {}), before: row.before, target: row.target, method: 'terminology', termId: entry.id, termRevision: baseline.revision,
          replacements: row.replacements, termExceptions: (snapshot.edits.edits[id]?.termExceptions || current.termExceptions || []).filter((e) => e.term_id !== entry.id) };
      });
      return commitReviewChanges(dir, snapshot, changes);
    }
    if (data.action === 'exception') {
      const unit = termReviewUnits(snapshot.model).find((u) => u.id === data.unitId && !u.artifact);
      const e = data.exception;
      if (!unit || !exceptionLocation(unit.source, unit.target, entry, e))
        fail(400, '请逐处填写确实存在的原文引句、替代译法、出现序号和具体特殊语义依据。');
      const exceptions = (snapshot.edits.edits[unit.id]?.termExceptions || unit.termExceptions || []).filter((old) =>
        !(old.term_id === entry.id && (old.source_occurrence === e.source_occurrence || old.translation_quote === e.translation_quote && old.occurrence === e.occurrence)));
      exceptions.push({ term_id: entry.id, source_quote: e.source_quote, source_occurrence: e.source_occurrence, translation_quote: e.translation_quote, occurrence: e.occurrence, reason: e.reason.trim(), origin: 'user' });
      return commitReviewChanges(dir, snapshot, [{ unitId: unit.id, before: unit.target, target: unit.target,
        ...(unit.noteId ? { noteId: unit.noteId } : {}), method: 'terminology-exception', termId: entry.id, termExceptions: exceptions }]);
    }
    fail(400, '术语操作无效。');
  }, { root, details: { name: '规定并统一术语译法' } });
}
