import path from 'node:path';
import { readJson, writeJson, sha256, sleep } from './utils.mjs';
import { annotationParagraphs } from './annotations.mjs';
import { transientError, retryDelay } from './reliability.mjs';

export const TERM_POLICY = 'full-source-fixed-terms-v1';
export const termFile = (dir) => path.join(dir, '00_shared/term-baseline.json');
export const termId = (term) => `term-${sha256(term.trim().toLowerCase()).slice(0, 16)}`;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function termPattern(entry, flags = 'giu') {
  const variants = [...new Set([entry.term, ...(entry.aliases || [])])].filter(Boolean).sort((a,b) => b.length-a.length);
  return new RegExp(variants.map((s) => `${/^[\p{Script=Latin}\p{N}_]/u.test(s) ? '(?<![\\p{L}\\p{N}_])' : ''}${literal(s).replace(/\s+/g, '[\\s-]+')}${/[\p{Script=Latin}\p{N}_]$/u.test(s) ? '(?![\\p{L}\\p{N}_])' : ''}`).join('|'), flags);
}
export const termOccurrences = (source, entry) => [...String(source).matchAll(termPattern(entry))].map((m) => ({ quote: m[0], start: m.index, end: m.index+m[0].length }));
export const literalOccurrences = (text, phrase) => phrase ? [...String(text).matchAll(new RegExp(literal(phrase), 'gu'))].map((m) => ({ start: m.index, end: m.index + phrase.length })) : [];
export function exceptionLocation(source, target, entry, e) {
  if (typeof e?.reason !== 'string' || e.reason.trim().length < 12 || typeof e.source_quote !== 'string' || !e.source_quote.trim()
    || typeof e.translation_quote !== 'string' || !e.translation_quote.trim() || e.translation_quote === entry.translation
    || !Number.isInteger(e.source_occurrence) || !Number.isInteger(e.occurrence)) return null;
  const sourceHit = termOccurrences(source, entry)[e.source_occurrence - 1];
  const targetHit = literalOccurrences(target, e.translation_quote)[e.occurrence - 1];
  if (!sourceHit || !targetHit || !literalOccurrences(source, e.source_quote).some((q) => q.start <= sourceHit.start && q.end >= sourceHit.end)
    || literalOccurrences(target, entry.translation).some((q) => q.start < targetHit.end && q.end > targetHit.start)) return null;
  return { source: sourceHit, target: targetHit };
}
export async function loadTermBaseline(dir) {
  try { return await readJson(termFile(dir)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { policy: TERM_POLICY, revision: 0, entries: [], status: 'not-prepared' }; }
}
export function termReviewUnits(model) {
  const notes = new Map(model.units.flatMap((u) => (u.authorNotes || []).filter((r) => r.note).map((r) => [r.noteId, r.note])));
  return [...model.units, ...[...notes.values()].map((n) => ({ id: `note:${n.id}`, noteId: n.id, page: n.page,
    source: n.source, target: n.translation || '', termExceptions: n.termExceptions || [], issueIds: [] }))];
}
export function termContext(baseline, blocks) {
  return { policy: TERM_POLICY, revision: baseline.revision, sourceHash: baseline.sourceHash,
    entries: baseline.entries.filter((e) => !blocks || blocks.some((b) => termOccurrences(b.source, e).length)) };
}

export function validateTermEntry(data) {
  const required = (v, max) => typeof v === 'string' && v.trim() && v.length <= max;
  if (!required(data.term, 160) || !required(data.translation, 160) || !required(data.definition, 4000)
    || !Array.isArray(data.aliases) || !Array.isArray(data.variants)
    || [...data.aliases, ...data.variants].some((s) => !required(s, 160))) throw Object.assign(new Error('请填写源语术语、标准译法和语义依据，变体须为文字列表。'), { status: 400 });
  return { id: termId(data.term), term: data.term.trim(), translation: data.translation.trim(), definition: data.definition.trim(),
    aliases: [...new Set(data.aliases.map((s) => s.trim()))], variants: [...new Set(data.variants.map((s) => s.trim()))].filter((s) => s !== data.translation.trim()) };
}

export function verifiedTermEntries(rawEntries, units) {
  if (!Array.isArray(rawEntries)) throw new Error('译前术语分析未返回有效条目，尚未开始翻译。');
  return rawEntries.map(raw => {
    const entry = validateTermEntry({ ...raw, variants: raw.variants || [] });
    if (!Array.isArray(raw.evidence) || !raw.evidence.length) throw new Error('术语分析缺少原文依据。');
    const evidence = raw.evidence.flatMap(e => {
      const at = units.findIndex(b => b.block_id === e.blockId), block = units[at];
      const record = (b, quote) => ({ blockId: b.block_id, page: b.page || null, quote });
      if (block && e.quote?.trim() && block.source.includes(e.quote)) return [record(block, e.quote)];
      // Some approved Chinese appendices retain a unit per printed line. An
      // exact quote may cross these boundaries; retain an exact fragment and
      // its actual location for every contributing unit, never repair OCR.
      if (block && e.quote?.trim()) for (const separator of ['', ' ', '\n']) {
        const nearby = units.slice(Math.max(0, at - 1), at + 10);
        let text = '';
        const spans = nearby.map(b => { if (text) text += separator; const start = text.length; text += b.source; return { b, start, end: text.length }; });
        const start = text.indexOf(e.quote), end = start + e.quote.length;
        if (start < 0) continue;
        return spans.filter(s => s.start < end && s.end > start).map(s => ({
          ...record(s.b, text.slice(Math.max(start, s.start), Math.min(end, s.end))),
          alignedFrom: { blockId: e.blockId, quote: e.quote }
        }));
      }
      throw new Error(`术语 ${entry.term} 的原文依据无法核实（blockId: ${e.blockId}）。引句必须逐字存在于该单元或邻接单元；不得改写或拼接不相邻的引句。`);
    });
    if (!raw.evidence.some(e => termOccurrences(e.quote, entry).length))
      throw new Error(`术语 ${entry.term} 的原文依据无法核实：至少一条引句须包含 term 或真实源文 alias，不能仅凭代词释义推定术语。`);
    return { ...entry, evidence, origin: 'source-analysis' };
  });
}

// Every source batch is analyzed before any translation can be sent. Results are
// keyed by source content and survive a network failure or a process restart.
export async function prepareTermBaseline(dir, blocks, { client, sourceHash, targetLanguage, glossary = '', checkpoint = () => {}, onProgress = () => {}, maxChars = 24000, maxAttempts = 3, sleepImpl = sleep, commit = (fn) => fn() } = {}) {
  const previous = await loadTermBaseline(dir);
  const sourceDigest = sha256(JSON.stringify(blocks.map((b) => [b.block_id, b.source])));
  if (previous.policy === TERM_POLICY && previous.status === 'ready' && previous.sourceDigest === sourceDigest && previous.targetLanguage === targetLanguage) return previous;
  const batches = []; let batch = [], size = 0;
  for (const block of blocks) {
    if (batch.length && size + block.source.length > maxChars) { batches.push(batch); batch = []; size = 0; }
    batch.push(block); size += block.source.length;
  }
  if (batch.length) batches.push(batch);
  const directory = path.join(dir, '00_shared/term-analysis', sha256(JSON.stringify({ sourceDigest, targetLanguage, policy: TERM_POLICY, glossary })));
  const candidates = [], coverage = [];
  for (const [index, units] of batches.entries()) {
    await checkpoint();
    await onProgress({ phase: 'terminology', completed: index, total: batches.length, sourceBlocks: blocks.length });
    const file = path.join(directory, `${String(index+1).padStart(4,'0')}.json`);
    const hash = sha256(JSON.stringify(units));
    let saved;
    try { saved = await readJson(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (saved?.hash !== hash) {
      let feedback = '';
      for (let attempt = 1; ; attempt++) {
      await checkpoint();
      let response;
      try {
      response = await client.extractTerms(units, { targetLanguage, glossary, batch: index+1, total: batches.length, feedback });
      } catch (error) {
        if (!transientError(error) || attempt >= maxAttempts) throw error;
        await onProgress({ phase: 'terminology-retry', completed: index, total: batches.length, attempt, reason: error.code || 'network' });
        await sleepImpl(retryDelay(error, attempt, { baseMs: error.code === 'CONCURRENCY_LIMIT' || error.status === 429 ? 30000 : 2000, maxMs: 30000 }));
        continue;
      }
      // Keep the received evidence for diagnosis; only verified entries enter the baseline.
      await writeJson(path.join(directory, `${String(index+1).padStart(4,'0')}-response-${Date.now()}-${attempt}.json`), response);
      try {
      const entries = verifiedTermEntries(response.value?.entries, units);
      saved = { hash, entries, blockIds: units.map((b) => b.block_id), analyzedAt: new Date().toISOString() };
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        feedback = error.message;
        await onProgress({ phase: 'terminology-retry', completed: index, total: batches.length, attempt, reason: feedback });
        continue;
      }
      await writeJson(file, saved);
      break;
      }
    }
    candidates.push(...saved.entries); coverage.push(...saved.blockIds);
  }
  if (JSON.stringify(coverage) !== JSON.stringify(blocks.map((b) => b.block_id))) throw new Error('译前术语分析未覆盖全部原文。');
  const grouped = new Map();
  for (const e of candidates) {
    const key = e.term.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(e);
  }
  await checkpoint();
  await onProgress({ phase: 'terminology-consolidation', completed: batches.length, total: batches.length });
  let entries = [], feedback = '';
  const manualTerms = (await loadTermBaseline(dir)).entries.filter(e => e.origin === 'user')
    .map(({ term, translation, aliases, definition }) => ({ term, translation, aliases, definition }));
  if (candidates.length) for (let attempt = 1; ; attempt++) {
    await checkpoint();
    try {
      const consolidated = await client.consolidateTerms([...grouped.values()], { targetLanguage, glossary, manualTerms, feedback });
      await writeJson(path.join(directory, `consolidation-response-${Date.now()}-${attempt}.json`), consolidated);
      if (!Array.isArray(consolidated.value?.entries)) throw new Error('全文术语基线生成失败。');
      const errors = [];
      entries = consolidated.value.entries.flatMap(raw => {
        try {
          const entry = validateTermEntry({ ...raw, variants: raw.variants || [] });
          const evidence = candidates.filter(e => termOccurrences(e.term, entry).length || termOccurrences(entry.term, e).length).flatMap(e => e.evidence);
          if (!evidence.length) throw new Error(`术语 ${entry.term} 不在已核实的原文候选中。若规范化了拼写，必须在 aliases 中保留对应的真实原文拼写，不能丢弃原文定位依据。`);
          return [{ ...entry, evidence: [...new Map(evidence.map(e => [e.blockId+':'+e.quote, e])).values()], origin: 'source-analysis' }];
        } catch (error) { errors.push(error.message); return []; }
      });
      if (errors.length) throw new Error(errors.join('\n'));
      break;
    } catch (error) {
      if (attempt >= maxAttempts || error.code === 'PAUSED' || error.code === 'AUTHENTICATION_ERROR' || error.status === 401 || error.status === 403) throw error;
      feedback = error.message;
      await onProgress({ phase: 'terminology-consolidation-retry', completed: batches.length, total: batches.length, attempt, reason: feedback });
      if (transientError(error)) await sleepImpl(retryDelay(error, attempt, { baseMs: error.code === 'CONCURRENCY_LIMIT' || error.status === 429 ? 30000 : 2000, maxMs: 30000 }));
    }
  }
  if (candidates.length && !entries.length) throw new Error('全文已识别术语，但未生成固定译法。');
  return commit(async () => {
  // Manual rules may have been updated while the full-source analysis ran.
  const current = await loadTermBaseline(dir);
  const manual = current.entries.filter((e) => e.origin === 'user');
  const overlaps = (a, b) => [a.term, ...a.aliases].some((s) => [b.term, ...b.aliases].some((t) => s.toLowerCase() === t.toLowerCase()));
  const merged = [...entries.filter((e) => !manual.some((m) => overlaps(e, m))), ...manual];
  const baseline = { policy: TERM_POLICY, revision: current.revision+1, status: 'ready', sourceHash, sourceDigest, targetLanguage,
    analyzedAt: new Date().toISOString(), coverage: { blocks: coverage.length, batches: batches.length, blockIds: coverage }, entries: merged };
  await writeJson(path.join(directory, 'baseline.json'), baseline);
  await writeJson(termFile(dir), baseline);
  return baseline;
  });
}

export function terminologyIssues(blocks, translations, baseline = { entries: [] }) {
  const result = [], targets = new Map(translations.map((t) => [t.block_id, t]));
  for (const block of blocks) {
    const t = targets.get(block.block_id); if (!t) continue;
    const allExceptions = Array.isArray(t.term_exceptions) ? t.term_exceptions : [];
    if (t.term_exceptions !== undefined && !Array.isArray(t.term_exceptions) || allExceptions.some(e => !e || !baseline.entries?.some(term => term.id === e.term_id))) {
      result.push({ category: 'terminology_inconsistency', severity: 'warning', block_id: block.block_id, source_quote: '', translation_quote: '',
        description: '术语例外记录格式无效或指向不存在的术语；译文已保留，待补充可核实的逐处依据。', recommendation: '核对术语编号并补充本处原文依据。' });
    }
    for (const entry of baseline.entries || []) {
      const occurrences = termOccurrences(block.source, entry); if (!occurrences.length) continue;
      const exceptions = allExceptions.filter((e) => e?.term_id === entry.id);
      const accepted = [], sourceUsed = new Set();
      for (const exception of exceptions) {
        const location = exceptionLocation(block.source, t.translation, entry, exception);
        const valid = location && !sourceUsed.has(exception.source_occurrence)
          && !accepted.some((a) => a.target.start < location.target.end && a.target.end > location.target.start);
        if (valid) { accepted.push(location); sourceUsed.add(exception.source_occurrence); }
        result.push({ category: valid ? 'terminology_exception' : 'terminology_inconsistency', severity: valid ? 'note' : 'warning', block_id: block.block_id,
          source_quote: exception.source_quote || '', translation_quote: exception.translation_quote || '',
          ...(valid ? { targetStart: location.target.start } : {}),
          description: valid ? `术语例外（第 ${exception.occurrence} 处）：${entry.term} 的标准译法为“${entry.translation}”，此处用“${exception.translation_quote}”。依据：${exception.reason}` : `术语 ${entry.term} 的例外说明缺少可核实的逐处依据。`,
          recommendation: valid ? '审阅该处特殊用意；此说明只适用于所标明的一次出现。' : `统一为“${entry.translation}”，或补充该处特殊用意的原文证据。` });
      }
      const standard = literalOccurrences(t.translation, entry.translation);
      const variants = (entry.variants || []).filter((v) => literalOccurrences(t.translation, v).some((hit) =>
        ![...standard, ...accepted.map((a) => a.target)].some((safe) => safe.start <= hit.start && safe.end >= hit.end)));
      if ((!standard.length && accepted.length < occurrences.length) || variants.length) {
        result.push({ category: 'terminology_inconsistency', severity: 'warning', block_id: block.block_id,
          source_quote: occurrences[0].quote, translation_quote: variants[0] || '',
          description: `固定术语 ${entry.term} 应译为“${entry.translation}”，发现未逐处说明的其他译法${variants.length ? `：${variants.join('、')}` : '或缺少标准译法'}。`,
          recommendation: `统一采用“${entry.translation}”；仅在原文确有特殊用意时逐次说明例外。` });
      }
    }
  }
  return result;
}

export function attachTermBaseline(model, baseline, edits = { edits: {} }) {
  const reviewUnits = termReviewUnits(model);
  const owners = (id) => model.units.filter((u) => u.id === id || id.startsWith('note:') && (u.authorNotes || []).some((r) => `note:${r.noteId}` === id));
  const checks = terminologyIssues(reviewUnits.filter((u) => !u.artifact).map((u) => ({ block_id: u.id, source: u.source })),
    reviewUnits.map((u) => ({ block_id: u.id, translation: u.target, term_exceptions: edits.edits[u.id]?.termExceptions || u.termExceptions || [] })), baseline)
    .map((q) => ({ ...q, id: `term-check-${sha256(JSON.stringify(q)).slice(0, 20)}`, blockIds: owners(q.block_id).map((u) => u.blockId), scope: 'body' }));
  const belongs = (q, u) => q.block_id === u.id || q.block_id.startsWith('note:') && (u.authorNotes || []).some((r) => `note:${r.noteId}` === q.block_id);
  return { ...model, termBaseline: baseline, issues: [...model.issues.filter((q) => !q.id.startsWith('term-check-')), ...checks],
    units: model.units.map((u) => ({ ...u,
      termExceptions: edits.edits[u.id]?.termExceptions || u.termExceptions || [],
      issueIds: [...u.issueIds.filter((id) => !id.startsWith('term-check-')), ...checks.filter((q) => belongs(q, u)).map((q) => q.id)],
      translatorNotes: [...(u.translatorNotes || []).filter((n) => !n.id.startsWith('term-check-')),
        ...checks.filter((q) => belongs(q, u) && q.category === 'terminology_exception').map((q) => ({ id: q.id, unitId: u.id,
          paragraphId: annotationParagraphs(u).find((p) => q.block_id.startsWith('note:') ? p.references.some((r) => `note:${r.noteId}` === q.block_id) : p.targetStart <= q.targetStart && p.targetEnd > q.targetStart)?.id || 'p1',
          text: (q.block_id.startsWith('note:') ? '作者原注中的' : '') + q.description, origin: 'terminology' }))]
    })) };
}
