import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { prepareTermBaseline, termOccurrences, terminologyIssues, validateTermEntry, loadTermBaseline, termFile, attachTermBaseline, verifiedTermEntries } from '../src/term-baseline.mjs';
import { previewTermChanges } from '../src/term-management.mjs';
import { writeJson } from '../src/utils.mjs';
import { writeReadingOutputs } from '../src/reading-outputs.mjs';
import { reviewSnapshot, applyReviewEdit } from '../src/review-edits.mjs';
import { createWebServer } from '../src/web-server.mjs';
import { annotationDirectory } from '../src/annotation-store.mjs';

const entry = validateTermEntry({ term: 'radio operator', translation: '无线电操作员', definition: '作者指携带和操作收音机、组织群众收听的技术人员。', aliases: ['radio operators'], variants: ['广播收音员', '收音员', '广播员', '操作员'] });
async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'fixed-terms-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 })); return dir; }

test('full-source scan covers every batch before consolidation, resumes checkpoints, and preserves a concurrent manual alias rule', async (t) => {
  const dir = await temp(t), blocks = [{ block_id: 'U1', source: 'Radio operators carried radios.', page: 1 }, { block_id: 'U2', source: 'A radio operator organized listening.', page: 2 }];
  const visited = []; let fail = true, consolidated = 0;
  const client = { extractTerms: async (batch) => {
    visited.push(batch[0].block_id);
    if (batch[0].block_id === 'U2' && fail) throw new Error('temporary interruption');
    return { value: { entries: [{ ...entry, translation: '广播员', evidence: [{ blockId: batch[0].block_id, quote: batch[0].source }] }] } };
  }, consolidateTerms: async (groups) => {
    consolidated++; assert.equal(groups.flat().flatMap(e => e.evidence).length, 2);
    // A human rule saved while the scan is underway must win, even if canonical form differs.
    await writeJson(termFile(dir), { revision: 3, entries: [{ ...entry, origin: 'user' }] });
    return { value: { entries: [{ ...entry, term: 'radio operators', translation: '广播员', aliases: ['radio operator'] }] } };
  } };
  const options = { client, sourceHash: 'approved', targetLanguage: 'zh-Hans', maxChars: 35 };
  await assert.rejects(prepareTermBaseline(dir, blocks, options), /interruption/);
  assert.equal(consolidated, 0); assert.equal((await loadTermBaseline(dir)).status, 'not-prepared');
  fail = false;
  const baseline = await prepareTermBaseline(dir, blocks, options);
  assert.deepEqual(visited, ['U1', 'U2', 'U2']); assert.equal(consolidated, 1);
  assert.deepEqual(baseline.coverage.blockIds, ['U1', 'U2']); assert.equal(baseline.revision, 4);
  assert.equal(baseline.entries.length, 1); assert.equal(baseline.entries[0].translation, '无线电操作员');
  await prepareTermBaseline(dir, blocks, options); assert.equal(consolidated, 1);
});

test('invented source evidence never becomes a fixed translation baseline', async (t) => {
  const dir = await temp(t);
  await assert.rejects(prepareTermBaseline(dir, [{ block_id: 'U1', source: 'Actual source.' }], {
    client: { extractTerms: async () => ({ value: { entries: [{ ...entry, evidence: [{ blockId: 'U1', quote: 'Invented radio operator.' }] }] } }) }, targetLanguage: 'zh-Hans'
  }), /无法核实/);
  assert.equal((await loadTermBaseline(dir)).entries.length, 0);
});

test('invalid terminology evidence is corrected before publication, with bounded network retries', async (t) => {
  const dir = await temp(t), block = { block_id: 'U1', source: 'Radio operators carried radios.' };
  const feedback = [], delays = [];
  const baseline = await prepareTermBaseline(dir, [block], {
    targetLanguage: 'zh-Hans', sleepImpl: async delay => delays.push(delay),
    client: { extractTerms: async (_units, context) => {
      feedback.push(context.feedback);
      if (feedback.length === 1) throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
      assert.equal((await loadTermBaseline(dir)).status, 'not-prepared');
      return { value: { entries: [{ ...entry, evidence: [{ blockId: 'U1', quote: feedback.length === 2 ? 'Invented radio operators.' : block.source }] }] } };
    }, consolidateTerms: async () => ({ value: { entries: [entry] } }) }
  });
  assert.equal(feedback.length, 3);
  assert.match(feedback[2], /radio operator.*U1/);
  assert.equal(delays.length, 1);
  assert.equal(baseline.status, 'ready');
  assert.equal(baseline.entries[0].evidence[0].quote, block.source);
});

test('definition evidence may span paragraphs but must include an exact quote of the term', async (t) => {
  const blocks = [{ block_id: 'U1', source: 'Radio operators carried radios. Their duty was to organize listening.' },
    { block_id: 'U2', source: 'Their duty was to organize listening.' }];
  const first = { blockId: 'U1', quote: 'Radio operators carried radios.' };
  const second = { blockId: 'U1', quote: 'Their duty was to organize listening.' };
  const options = evidence => ({ maxAttempts: 1, targetLanguage: 'zh-Hans', client: {
    extractTerms: async () => ({ value: { entries: [{ ...entry, evidence }] } }),
    consolidateTerms: async () => ({ value: { entries: [entry] } })
  } });
  const baseline = await prepareTermBaseline(await temp(t), blocks, options([first, second]));
  assert.equal(baseline.entries[0].evidence.length, 2);
  await assert.rejects(prepareTermBaseline(await temp(t), blocks, options([second])), /至少一条引句/);
  const across = await prepareTermBaseline(await temp(t), blocks, options([first, { ...second, blockId: 'U2' }]));
  assert.equal(across.entries[0].evidence[1].blockId, 'U2');
});

test('exact quotations spanning printed source lines retain each actual source location without accepting altered or disconnected quotes', () => {
  const units = [{ block_id: 'U1', source: 'Radio operators carried radios. ' }, { block_id: 'U2', source: 'Their duty was to organize listening.' }];
  const raw = { ...entry, evidence: [{ blockId: 'U1', quote: units.map(b => b.source).join('') }] };
  const result = verifiedTermEntries([raw], units)[0];
  assert.deepEqual(result.evidence.map(e => [e.blockId, e.quote]), units.map(b => [b.block_id, b.source]));
  assert.equal(result.evidence[1].alignedFrom.quote, raw.evidence[0].quote);
  assert.throws(() => verifiedTermEntries([{ ...raw, evidence: [{ blockId: 'U1', quote: 'Radio operators carried radios. Their duty was to organize broadcasts.' }] }], units), /无法核实/);
  assert.throws(() => verifiedTermEntries([raw], [units[0], { block_id: 'gap', source: 'Unrelated intervening content.' }, units[1]]), /无法核实/);
});

test('consolidation retries a normalized spelling that dropped its source alias and carries manual rules', async (t) => {
  const dir = await temp(t), candidate = { ...entry, term: 'radioas-state', aliases: [], translation: '广播即国家' };
  await writeJson(termFile(dir), { revision: 1, entries: [{ ...entry, origin: 'user' }], status: 'not-prepared' });
  let attempts = 0;
  const baseline = await prepareTermBaseline(dir, [{ block_id: 'U1', source: 'It was the radioas-state that interpreted messages.' }], {
    targetLanguage: 'zh-Hans', client: {
      extractTerms: async (units) => ({ value: { entries: [{ ...candidate, evidence: [{ blockId: 'U1', quote: units[0].source }] }] } }),
      consolidateTerms: async (_groups, context) => {
        attempts++;
        assert.equal(context.manualTerms[0].translation, '无线电操作员');
        if (attempts === 2) assert.match(context.feedback, /radio-as-state.*aliases/);
        return { value: { entries: [{ ...candidate, term: 'radio-as-state', aliases: attempts === 1 ? [] : ['radioas-state'] }] } };
      }
    }
  });
  assert.equal(attempts, 2);
  assert.equal(baseline.entries.find(e => e.term === 'radio-as-state').evidence[0].blockId, 'U1');
  assert.equal(baseline.entries.find(e => e.term === 'radio operator').translation, '无线电操作员');
});

test('literal aliases match singular, plural and hyphens; previews protect the standard term and flag ambiguous occupations', () => {
  assert.equal(termOccurrences('Radio operator, RADIO-OPERATORS; radio operatorship.', entry).length, 2);
  assert.equal(termOccurrences('声学国家的形成与声学国家的边界。', { term: '声学国家', aliases: [] }).length, 2);
  const rows = previewTermChanges({ units: [
    { id: 'a', source: 'Radio operators worked.', target: '无线电操作员、广播收音员和操作员工作。' },
    { id: 'b', source: 'An announcer spoke.', target: '广播员说话。' },
    { id: 'c', source: 'Radio operators and announcers.', target: '收音员和播音员。' },
    { id: 'd', source: 'Radio operators（收音员）.', target: '收音员。', languageSegments: [{ language: 'zh-Hans', text: '收音员' }] }
  ] }, entry);
  assert.equal(rows.length, 3); assert.equal(rows[0].target, '无线电操作员、无线电操作员和无线电操作员工作。');
  assert.equal(rows[0].replacements.length, 2); assert.equal(rows[0].selected, true);
  assert.equal(rows[1].selected, false); assert.equal(rows[2].selected, false);
});

test('exceptions are occurrence-specific, cannot be duplicated, and invalid evidence cannot suppress an inconsistency', () => {
  const blocks = [{ block_id: 'U1', source: 'Radio operators came. A radio operator left.' }];
  const exception = { term_id: entry.id, source_quote: 'Radio operators came.', source_occurrence: 1, translation_quote: '广播员', occurrence: 1, reason: '此处原文特指暂时代班播音，操作工作已经由另一组人员负责。' };
  const check = (exceptions) => terminologyIssues(blocks, [{ block_id: 'U1', translation: '广播员来了。广播员离开。', term_exceptions: exceptions }], { entries: [entry] });
  assert.equal(check([exception]).filter(q => q.severity === 'warning').length, 1);
  assert.equal(check([exception, exception]).filter(q => q.severity === 'warning').length, 2);
  assert.ok(check([{ ...exception, source_quote: 'Invented.' }]).every(q => q.severity === 'warning'));
  const second = { ...exception, source_occurrence: 2, source_quote: 'A radio operator left.', occurrence: 2 };
  assert.equal(check([exception, second]).filter(q => q.severity === 'warning').length, 0);
  assert.equal(check([exception, second]).length, 2);
  const standard = terminologyIssues(blocks, [{ block_id: 'U1', translation: '无线电操作员来了。无线电操作员离开。' }], { entries: [entry] });
  assert.deepEqual(standard, []);
});

test('exception notes attach to the actual natural paragraph', () => {
  const source = 'Radio operators came. A radio operator left.', target = '无线电操作员来了。广播员离开。';
  const unit = { id: 'U1-0', blockId: 'U1', source, target, issueIds: [], paragraphMap: { paragraphs: [
    { id: 'p1', sourceStart: 0, sourceEnd: 22, targetQuote: '无线电操作员来了。' }, { id: 'p2', sourceStart: 22, sourceEnd: source.length, targetQuote: '广播员离开。' }
  ] }, termExceptions: [{ term_id: entry.id, source_quote: 'A radio operator left.', source_occurrence: 2, translation_quote: '广播员', occurrence: 1, reason: '此处原文中的角色已经调任播音岗位，与此前的技术职责有所区别。' }] };
  const model = attachTermBaseline({ units: [unit], issues: [] }, { entries: [entry] });
  assert.equal(model.units[0].translatorNotes[0].paragraphId, 'p2');
});

test('terms API saves, previews and applies with revision locks; retains human edits, history and exports', async (t) => {
  const root = await temp(t), dir = path.join(root, 'projects/book');
  const manifest = { projectId: 'book', status: 'qa_failed', source: { approvedSha256: 's' } };
  await writeReadingOutputs(dir, [
    { block_id: 'U000001', source: 'Radio operators carried radios.', page: 1 }, { block_id: 'U000002', source: 'A separate sentence.', page: 2 }
  ], [{ block_id: 'U000001', translation: '收音员携带收音机。' }, { block_id: 'U000002', translation: '另一个句子。' }], { issues: [] }, manifest);
  await writeJson(path.join(dir, 'manifest.json'), manifest);
  const baseModel = (await reviewSnapshot(dir)).model;
  await writeJson(path.join(annotationDirectory(dir, baseModel.version), 'catalog.json'), { version: baseModel.version, sourceHash: 's',
    notes: [{ id: 'note-a', source: 'Radio operators assembled.', translation: '收音员集合。', label: '1', page: 1 }],
    references: [{ unitId: 'U000001-0', noteId: 'note-a', sourceStart: 0, label: '1', targetQuote: '收音机。' }], paragraphMaps: {}, unresolved: [], issues: [] });
  const server = createWebServer({ root, workflow: {}, configLoader: async () => ({ openai: {} }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const post = (data) => fetch(`http://127.0.0.1:${server.address().port}/api/projects/book/terms`, { method: 'POST', headers: { 'X-Local-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  let s = await reviewSnapshot(dir);
  const args = () => ({ version: s.model.version, revision: s.edits.revision, termRevision: s.model.termBaseline.revision, annotationRevision: s.model.annotations?.revision || 0 });
  const saved = await post({ ...args(), action: 'save', entry }); assert.equal(saved.status, 200); s = await saved.json();
  let preview = await (await post({ ...args(), action: 'preview', termId: entry.id })).json();
  s = await applyReviewEdit(dir, { version: s.model.version, revision: s.edits.revision, unitId: 'U000002-0', before: s.model.units[1].target, target: '必须保留的人工修订。' }, { root });
  assert.equal((await post({ ...args(), action: 'apply', termId: entry.id, previewId: preview.id, previewHash: preview.hash, unitIds: ['U000001-0'] })).status, 409);
  preview = await (await post({ ...args(), action: 'preview', termId: entry.id })).json();
  assert.ok(preview.rows.some(r => r.noteId === 'note-a'));
  const result = await post({ ...args(), action: 'apply', termId: entry.id, previewId: preview.id, previewHash: preview.hash, unitIds: ['U000001-0', 'note:note-a'] });
  assert.equal(result.status, 200); s = await result.json();
  assert.equal(s.edits.revision, 2); assert.equal(s.model.units[0].target, '无线电操作员携带收音机。');
  assert.equal(s.model.units[1].target, '必须保留的人工修订。'); assert.equal(s.edits.history.at(-1).method, 'terminology');
  const text = await readFile(path.join(dir, s.edits.outputs.chinese), 'utf8');
  assert.match(text, /无线电操作员/); assert.match(text, /必须保留的人工修订/);
  assert.equal(s.model.units[0].authorNotes[0].note.translation, '无线电操作员集合。');
  assert.match(text, /无线电操作员集合。/); assert.equal(s.model.annotations.revision, 1);
  assert.equal((await post({ ...args(), action: 'exception', termId: entry.id, unitId: 'U000001-0', exception: {} })).status, 400);
});
