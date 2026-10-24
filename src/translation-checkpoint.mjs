import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { sha256 } from './utils.mjs';

export const unitIdentity = (u) => JSON.stringify({ source: u.source, spans: u.sourceSpans.map(({block_id,start,end}) => ({block_id,start,end})) });

// Explicitly adopted, user-reviewed work is authoritative translation content,
// independent of model request caches. Its source identity remains mandatory.
export async function readTranslationCheckpoint(directory, manifest, plan, targetLanguage) {
  const pointer = manifest.translationCheckpoint;
  if (!pointer) return null;
  const file = path.resolve(directory, pointer.file);
  const relative = path.relative(directory, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('译文接续档案路径无效。');
  const raw = await readFile(file, 'utf8');
  if (sha256(raw) !== pointer.sha256) throw Error('已采纳译文接续档案已变化，请核对后重新纳入进度。');
  const saved = JSON.parse(raw);
  if (saved.sourceSha256 !== manifest.source.approvedSha256 || saved.planVersion !== plan.version || saved.targetLanguage !== targetLanguage) throw Error('已采纳译文与当前原文、分组或目标语言不匹配，请先迁移译文，不得从头重译。');
  const units = new Map(plan.units.map(u=>[u.block_id,u])), translations = {};
  for (const entry of saved.entries) {
    const t=entry.translation, u=units.get(t?.block_id);
    if (!u || entry.identity !== unitIdentity(u) || translations[t.block_id] || typeof t.translation !== 'string' || !t.translation.trim()
      || !Array.isArray(t.translator_notes) || !Array.isArray(t.source_questions)) throw Error('已采纳译文的原文定位或内容无效。');
    translations[t.block_id] = t;
  }
  return { translations, issues: [], reviewChunks: [], fromPlanVersion: saved.oldPlanVersion,
    adoptedCheckpoint: pointer.file, qaPending: true };
}
