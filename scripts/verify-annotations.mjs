import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { reviewSnapshot } from "../src/review-edits.mjs";
import { annotationDirectory } from "../src/annotation-store.mjs";
import { annotationParagraphs, annotatedMarkdown } from "../src/annotations.mjs";
import { sourceParagraphs, validateAlignment } from "../src/annotation-jobs.mjs";
import { normalizeText, readJson, sha256, writeJson } from "../src/utils.mjs";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-annotations.mjs <project-directory>");
const dir = path.resolve(process.argv[2]);
const snapshot = await reviewSnapshot(dir);
const { model, edits } = snapshot;
const folder = annotationDirectory(dir, model.version);
const catalog = await readJson(path.join(folder, "catalog.json"));
const before = await readJson(path.join(folder, "body-before.json"));
const originalParagraphs = await readJson(path.join(folder, "source-paragraphs-v2.json"));
const manifest = await readJson(path.join(dir, "manifest.json"));
const approvedHash = sha256(normalizeText(await readFile(path.join(dir, manifest.source.approvedFile), "utf8")));
assert.equal(approvedHash, manifest.source.approvedSha256, "Approved transcription changed");
assert.equal(before.version, model.version, "Reading edition changed");
assert.equal(before.editRevision, edits.revision, "Human edits changed since preparation; compare revisions before publishing");
assert.equal(before.targets.length, model.units.length);
const hashes = new Map(before.targets.map((u) => [u.id, u.hash]));
for (const u of model.units) assert.equal(sha256(u.target || ""), hashes.get(u.id), `Body changed: ${u.id}`);
for (const [id, edit] of Object.entries(edits.edits)) assert.equal(model.units.find((u) => u.id === id)?.target, edit.target, `Human edit missing: ${id}`);
assert.ok(catalog.completedAt, "Annotation preparation incomplete");
assert.equal(catalog.unresolved.length, 0, "Unresolved references");
assert.equal(catalog.issues.length, 0, "Unresolved note extraction issues");
assert.equal(new Set(catalog.notes.map((n) => n.id)).size, catalog.notes.length, "Duplicate author note identifiers");
assert.equal(new Set(catalog.references.map((r) => r.id)).size, catalog.references.length, "Duplicate reference identifiers");
for (const note of catalog.notes) {
  assert.ok(note.source.trim() && note.translation?.trim(), `Missing note or translation: ${note.id}`);
  assert.ok(catalog.references.some((r) => r.noteId === note.id), `Unreferenced author note: ${note.id}`);
}
const groups = [];
for (const unit of model.units.filter((u) => u.authorNotes?.length)) {
  const refs = catalog.references.filter((r) => r.unitId === unit.id);
  const parts = sourceParagraphs(unit, originalParagraphs);
  assert.equal(unit.paragraphMap.targetHash, sha256(unit.target), `Stale paragraph map: ${unit.id}`);
  const value = { references: refs.map((r) => ({ id: r.id, quote: r.targetQuote })),
    paragraphs: unit.paragraphMap.paragraphs.map((p) => ({ id: p.id, quote: p.targetQuote })) };
  validateAlignment(unit, refs, parts, value);
  const rendered = annotationParagraphs(unit);
  assert.equal(rendered.length, parts.length, `Paragraph rendering fell back: ${unit.id}`);
  assert.equal(rendered.map((p) => p.source).join(""), unit.source, `Source paragraph coverage: ${unit.id}`);
  assert.equal(rendered.map((p) => p.target).join("").trimEnd(), unit.target.trimEnd(), `Target paragraph coverage: ${unit.id}`);
  for (const p of rendered) for (const r of p.references) {
    assert.equal(r.placement, "verified", `Unplaced reference: ${r.id}`);
    assert.ok(r.note?.translation && r.targetOffset > p.targetStart && r.targetOffset <= p.targetEnd, `Reference outside its paragraph: ${r.id}`);
  }
  groups.push({ unitId: unit.id, paragraphs: rendered.length, notes: rendered.map((p) => ({ paragraphId: p.id, labels: p.references.map((r) => r.label) })) });
}
const exports = await readJson(path.join(folder, "exports-current.json"));
assert.equal(exports.digest, sha256(JSON.stringify(model)), "Export does not reflect the current reading model");
assert.equal(exports.editRevision, edits.revision);
const chinese = await readFile(path.join(dir, exports.files["project_zh.md"]), "utf8");
const bilingual = await readFile(path.join(dir, exports.files["project_bilingual.md"]), "utf8");
assert.equal(chinese, annotatedMarkdown(model), "Chinese export differs from the current annotation rendering");
assert.equal(bilingual, annotatedMarkdown(model, { bilingual: true }), "Bilingual export differs from the current annotation rendering");
const report = { verifiedAt: new Date().toISOString(), readingVersion: model.version, approvedHash,
  approvedUnchanged: true, allBodyTargetsUnchanged: true, units: model.units.length,
  editRevision: edits.revision, humanEditedUnits: Object.keys(edits.edits),
  authorNotes: catalog.notes.length, translatedAuthorNotes: catalog.notes.filter((n) => n.translation).length,
  references: catalog.references.length, unmatchedReferences: catalog.unresolved.length,
  noteBearingUnits: groups.length, naturalParagraphsInNoteBearingUnits: groups.reduce((n, g) => n + g.paragraphs, 0),
  paragraphGroups: groups, exports };
const reportFile = path.join(folder, "verification.json");
await writeJson(reportFile, report);
console.log(JSON.stringify({ verified: true, notes: report.authorNotes, references: report.references, unchangedUnits: report.units,
  humanEditedUnits: report.humanEditedUnits.length, reportFile }, null, 2));
