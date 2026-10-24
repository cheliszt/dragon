import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeJson, readJson } from '../src/utils.mjs';
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from '../src/translation-plan.mjs';
import { parseStructuredMarkdown, structureMarkdown } from '../src/markdown.mjs';
import { buildReviewDocument } from '../src/review-document.mjs';
import { joinReadingParts, applyReviewGrouping, regroupAnnotationCatalog, groupedReviewChecks } from '../src/review-grouping.mjs';
import { reviewSnapshot, commitReviewChanges, applyReviewEdit } from '../src/review-edits.mjs';
import { readAnnotations } from '../src/annotation-store.mjs';

const plan = text => buildTranslationPlan(parseStructuredMarkdown(structureMarkdown(text)), 30);
test('bibliography entries survive page boundaries, capitalized continuations and tiny budgets', () => {
  const p = plan('BIBLIOGRAPHY\n\n“Xinwen zongshu” (The decision in factories, mines,\n\n<!-- pdf_page: 182 -->\n\nand enterprises throughout the country), Guowuyuan fazhi bangongshi ed, Zhonghua renmin\n\ngongheguo fagui huibian 1949-1954 (Beijing: Zhongguo fazhi chubanshe, 2005), vol.1, 507-508.\n\n“Zhonggong zhongyang guanyu tongling yu wo shang wu waijiao guanxi guojia de jizhe tingzhi yi\n\njizhe shenfen huodong gei huadongju deng de pifu” (The Party Central’s reply to the eastern\n\nChina bureau on journalists whose country has no diplomatic relationship with China should stop\n\ntheir journalist work in China), Zhongyang danganguan, Zhonggong zhongyang wenxian\n\nyanjiushi, ed, Zhonggong zhongyang wenjian xuanji (Selected writings of the Chinese\n\nCommunist Party Central) vol. 1 (Beijing: Renmin chubanshe, 2013), 1-4.\n\nSmith, John. Another book. London, 2020.');
  assert.equal(p.units.length, 4);
  assert.match(p.units[1].source, /Zhonghua renmin gongheguo/);
  assert.match(p.units[2].source, /tingzhi yi jizhe shenfen/);
  assert.match(p.units[2].source, /wenxian yanjiushi/);
  assert.ok(validatePlanCoverage(p));
  const model = buildReviewDocument(p.units, p.units.map(u => ({ block_id: u.block_id, translation: '完整译文。'.repeat(200) })), { issues: [] });
  assert.equal(model.units.length, p.units.length);
});

test('bibliography abbreviations continue, missing quote does not swallow next entries or appendix', () => {
  const p = plan('References\n\nSmith, John. “Broken quote (London, 2000).\n\nJones, Ann. Complete book (Paris, 2001).\n\n_____. Another book, vol.\n\n2 (Paris, 2002).\n\nAppendice 1 Program Schedule 1949\n\n18:00 18:10 Opening\n\n18:10 18:30 News\n\nAppendice 2 Drama\n\n全唱：这是一个未完的\n\n完整唱段\n\n妻白：另一个人物。');
  assert.equal(p.units.length, 10);
  assert.match(p.units[3].source, /vol\. 2/);
  assert.equal(p.units.at(-2).source, '全唱：这是一个未完的完整唱段');
  assert.equal(p.units.at(-1).source, '妻白：另一个人物。');
  assert.ok(validatePlanCoverage(p));
  assert.ok(validateSentenceBoundaries(p));
});

test('appendix listings in contents do not change the following main text section', () => {
  const p = plan('Appendice 1 Title ........ 209\n\nA prose paragraph with a\n\n<!-- pdf_page: 2 -->\n\ncontinuation.');
  assert.equal(p.units.at(-1).section, '正文');
  assert.match(p.units.at(-1).source, /with a continuation/);
  const listing = plan('<!-- pdf_page: 9 -->\n\nList of Appendices\n\nAppendice 1 Program Schedule 1949\n\nAppendice 2 Drama\n\n<!-- pdf_page: 10 -->\n\nA paragraph with a\n\n<!-- pdf_page: 11 -->\n\ncontinuation.');
  assert.equal(listing.units.at(-1).section, '正文');
  assert.equal(listing.units.at(-1).source, 'A paragraph with a continuation.');
  assert.ok(validatePlanCoverage(listing));
});

test('a semicolon between anonymous citations does not make them one entry', () => {
  const p = plan('References\n\nAnonymous, “First title,” Journal, 1950;\n\nAnonymous, “Second title,” Journal, 1954.');
  assert.equal(p.units.length, 3);
});

function fixtureModel() {
  return buildReviewDocument([
    { block_id: 'U000001', source: 'A title in the', page: 1, pages: [1], section: '参考文献', translationUnit: true, scope: 'body' },
    { block_id: 'U000002', source: 'second part.', page: 2, pages: [2], section: '参考文献', translationUnit: true, scope: 'body' },
    { block_id: 'U000003', source: 'Independent entry.', page: 2, pages: [2], section: '参考文献', translationUnit: true, scope: 'body' }
  ], [{ block_id: 'U000001', translation: '中文书' }, { block_id: 'U000002', translation: '名。' }, { block_id: 'U000003', translation: '独立条目。' }], { issues: [
    { block_id: 'U000002', severity: 'warning', category: 'meaning', description: 'Real uncertainty.' },
    { block_id: 'U000001', severity: 'note', category: 'translator_note', description: 'Artificial split.' }
  ] });
}

test('regrouped revisions preserve edits, notes, page links, history and subsequent editing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'regroup-'));
  try {
    const base = fixtureModel();
    await writeJson(path.join(dir, '04_qa/review-document.json'), base);
    await writeJson(path.join(dir, 'manifest.json'), { projectId: 'test', source: {} });
    const cat = { version: base.version, sourceHash: base.sourceHash, notes: [{ id: 'n1', label: '1', source: 'Note', translation: '旧注译。' }],
      references: [{ id: 'r1', noteId: 'n1', unitId: base.units[1].id, label: '1', sourceStart: 1, sourceEnd: 2, targetQuote: '名。' }],
      unresolved: [], issues: [], paragraphMaps: {} };
    await writeJson(path.join(dir, '08_annotations', base.version, 'catalog.json'), cat);
    await writeJson(path.join(dir, '08_annotations', base.version, 'current.json'), { revision: 2, notes: { n1: { translation: '人工注译。' } }, translatorNotes: [] });
    let snapshot = await reviewSnapshot(dir);
    snapshot = await commitReviewChanges(dir, snapshot, [{ unitId: base.units[0].id, before: '中文书', target: '人工修订书' }]);
    const source = joinReadingParts(snapshot.model.units.slice(0, 2), 'source').text;
    const grouping = { version: 'g1', groups: [{ unitIds: base.units.slice(0, 2).map(u => u.id), source }], resolvedIssueIds: [base.issues[1].id] };
    const merged = applyReviewGrouping(snapshot.model, grouping);
    assert.equal(merged.units[0].target, '人工修订书名。');
    assert.deepEqual(merged.units[0].pages, [1, 2]);
    assert.throws(() => applyReviewGrouping(base, { groups: [{ unitIds: [base.units[0].id, base.units[2].id], source }] }), /连续/);
    const stored = await readAnnotations(dir, snapshot.model);
    const migrated = regroupAnnotationCatalog(stored.catalog, snapshot.model, grouping);
    const after = await commitReviewChanges(dir, snapshot, [{ unitId: base.units[0].id, before: '人工修订书', groupedBefore: merged.units[0].target, target: merged.units[0].target }], { grouping, annotationCatalog: migrated });
    assert.equal(after.model.units.length, 2);
    assert.equal(after.model.units[0].target, '人工修订书名。');
    assert.equal(after.model.units[0].authorNotes[0].note.translation, '人工注译。');
    assert.equal(after.model.units[0].authorNotes[0].sourceStart, 'A title in the '.length + 1);
    assert.equal(after.model.units[0].authorNotes[0].placement, 'verified');
    assert.ok(after.model.issues.some(q => q.id === base.issues[0].id));
    assert.ok(!after.model.issues.some(q => q.id === base.issues[1].id));
    assert.equal(after.edits.history.length, 2);
    const proposalId = '11111111-1111-4111-8111-111111111111';
    await writeJson(path.join(dir, '04_qa/proposals', proposalId + '.json'), {
      state: 'completed', version: base.version, unitId: base.units[0].id, before: after.model.units[0].target,
      input: { source: base.units[0].source }, translation: '只译了半段的旧草稿。'
    });
    await assert.rejects(applyReviewEdit(dir, { version: base.version, revision: after.edits.revision, unitId: base.units[0].id,
      before: after.model.units[0].target, proposalId, target: '只译了半段的旧草稿。' }, { root: dir }), /分组已变化/);
    const edited = await applyReviewEdit(dir, { version: base.version, revision: after.edits.revision, unitId: base.units[0].id, before: after.model.units[0].target, target: '再次修订书名。' }, { root: dir });
    assert.equal(edited.model.units.length, 2);
    assert.equal(edited.model.units[0].target, '再次修订书名。');
    assert.equal((await readJson(path.join(dir, '04_qa/review-document.json'))).units.length, 3);
    assert.deepEqual(groupedReviewChecks({ units: { 'U000001-0': { groupingVersion: 'g1' }, 'U000002-0': {} } }, grouping).units, { 'U000001-0': { groupingVersion: 'g1' } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
