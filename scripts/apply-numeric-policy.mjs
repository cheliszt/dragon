import path from 'node:path';
import { readdir, readFile, copyFile } from 'node:fs/promises';
import { APP_ROOT } from '../src/config.mjs';
import { applyNumericPolicy, NUMERIC_POLICY_VERSION } from '../src/numeric-qa.mjs';
import { qaMarkdown } from '../src/qa.mjs';
import { readJson, writeJson, writeText, ensureDir, sha256 } from '../src/utils.mjs';
import { withTranslationLock } from '../src/translation-lock.mjs';
import { reviewSnapshot } from '../src/review-edits.mjs';
import { renderReviewHtml } from '../src/reading-outputs.mjs';

const rules = (await readFile(path.join(APP_ROOT, 'config/workflow.md'), 'utf8')).match(/\n   - `numeric`[\s\S]*?(?=\n5\.)/)[0];
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const results = [];
await withTranslationLock('numeric-policy-update', async () => {
  for (const entry of await readdir(path.join(APP_ROOT, 'projects'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(APP_ROOT, 'projects', entry.name);
    const saved = new Set();
    const backup = async (relative) => {
      if (saved.has(relative)) return;
      const destination = path.join(dir, '09_history', `${stamp}-before-numeric-policy`, relative);
      await ensureDir(path.dirname(destination));
      try { await copyFile(path.join(dir, relative), destination); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      saved.add(relative);
    };
    const workflowFile = '00_shared/workflow.md';
    let workflow;
    try { workflow = await readFile(path.join(dir, workflowFile), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (workflow && !workflow.includes('`numeric` 类问题一律')) {
      await backup(workflowFile);
      await writeText(path.join(dir, workflowFile), workflow.replace(/(\n4\.[^\n]*)(\r?\n)/, `$1${rules}$2`));
    }
    let model;
    try { model = await readJson(path.join(dir, '04_qa/review-document.json')); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const originalVersion = model.version;
    const textHash = sha256(JSON.stringify(model.units.map((u) => [u.id, u.source, u.target])));
    const grouped = new Map();
    for (const u of model.units.filter((u) => !u.artifact)) {
      if (!grouped.has(u.blockId)) grouped.set(u.blockId, { source: [], target: [] });
      grouped.get(u.blockId).source.push(u.originalSource || u.source);
      grouped.get(u.blockId).target.push(u.target);
    }
    const blocks = [...grouped].map(([block_id, text]) => ({ block_id, source: text.source.join('\n\n') }));
    const translations = [...grouped].map(([block_id, text]) => ({ block_id, translation: text.target.join('\n\n') }));
    const before = model.issues.filter((q) => q.category === 'numeric').length;
    model.issues = applyNumericPolicy(model.issues, blocks, translations);
    const visibleIds = new Set(model.issues.map((q) => q.id));
    const numericIds = new Set(model.issues.filter((q) => q.category === 'numeric').map((q) => q.id));
    model.units = model.units.map((u) => ({ ...u, issueIds: u.issueIds.filter((id) => visibleIds.has(id)),
      sourceMarks: u.sourceMarks.filter((m) => visibleIds.has(m.issueId) && !numericIds.has(m.issueId)),
      targetMarks: u.targetMarks.filter((m) => visibleIds.has(m.issueId) && !numericIds.has(m.issueId)) }));
    model.numericPolicy = NUMERIC_POLICY_VERSION;
    // Keep the edition identity so existing human edits and decisions stay attached.
    if (model.version !== originalVersion || textHash !== sha256(JSON.stringify(model.units.map((u) => [u.id, u.source, u.target])))) throw new Error('Translation or edition changed');
    await backup('04_qa/review-document.json');
    await writeJson(path.join(dir, '04_qa/review-document.json'), model);
    const report = await readJson(path.join(dir, '04_qa/final.json'));
    report.issues = applyNumericPolicy(report.issues, blocks, translations);
    report.summary = Object.fromEntries(['blocking', 'warning', 'note'].map((s) => [s, report.issues.filter((q) => q.severity === s).length]));
    report.status = report.summary.blocking ? 'failed' : 'passed';
    report.numericPolicy = NUMERIC_POLICY_VERSION;
    for (const file of ['04_qa/final.json', '04_qa/final.md']) await backup(file);
    await writeJson(path.join(dir, '04_qa/final.json'), report);
    await writeText(path.join(dir, '04_qa/final.md'), qaMarkdown(report));
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    const snapshot = await reviewSnapshot(dir);
    const htmlFiles = new Set([manifest.outputs?.bilingualHtml, snapshot.edits.outputs?.bilingualHtml].filter(Boolean));
    for (const relative of htmlFiles) {
      const pdfUrl = manifest.source.originalFile ? path.relative(path.dirname(path.join(dir, relative)), path.join(dir, manifest.source.originalFile)).split(path.sep).map(encodeURIComponent).join('/') : null;
      await backup(relative);
      await writeText(path.join(dir, relative), await renderReviewHtml(snapshot.model, { pdfUrl }));
    }
    if (manifest.status === 'qa_failed' && !report.summary.blocking) {
      await backup('manifest.json');
      manifest.status = 'completed';
      await writeJson(path.join(dir, 'manifest.json'), manifest);
    }
    results.push({ project: entry.name, before, after: numericIds.size, removed: before - numericIds.size,
      numericWarnings: model.issues.filter((q) => q.category === 'numeric' && q.severity !== 'note').length,
      summary: report.summary, editionPreserved: model.version === originalVersion, translationUnchanged: true });
  }
}, { root: APP_ROOT, details: { name: '更新数字质检规则与报告' } });
await writeJson(path.join(APP_ROOT, 'diagnostics', `${stamp}-numeric-policy.json`), results);
console.log(JSON.stringify(results, null, 2));
