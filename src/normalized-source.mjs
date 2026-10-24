import path from "node:path";
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from "./translation-plan.mjs";
import { writeJson, writeText, readJson, sha256 } from "./utils.mjs";
import { inspectPdfSourceLayout, PDF_LAYOUT_VERSION } from "./pdf-source-layout.mjs";

// The approved PDF transcription stays immutable; translation consumes this derived continuous text.
export async function prepareTranslationInput(dir, manifest, blocks, maxChars) {
  if (manifest.source.originalFile && path.extname(manifest.source.originalFile).toLowerCase() === '.pdf') {
    const file = path.join(dir, '04_qa/source-pdf-layout.json');
    let layout;
    try { layout = await readJson(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (layout?.schemaVersion !== PDF_LAYOUT_VERSION || layout.sourceDigest !== sha256(JSON.stringify(blocks))) {
      layout = await inspectPdfSourceLayout(path.join(dir, manifest.source.originalFile), blocks);
      await writeJson(file, layout);
    }
    manifest.source.pdfLayout = layout;
  }
  const plan = buildTranslationPlan(blocks, maxChars, { pdfLayout: manifest.source.pdfLayout });
  if (!plan.units.length || !validatePlanCoverage(plan)) throw new Error("连续原文覆盖检查失败，未提交翻译。");
  const folder = path.join(path.dirname(manifest.source.approvedFile), "translation-inputs", plan.version);
  const sourceFile = path.join(folder, "document.md"), planFile = path.join(folder, "translation-plan.json");
  const text = plan.units.map((u) => `<!-- block_id: ${u.block_id} -->\n<!-- pdf_pages: ${u.pages.join(", ")} -->\n\n${u.source.trim()}`).join("\n\n") + "\n";
  await writeText(path.join(dir, sourceFile), text);
  await writeJson(path.join(dir, planFile), plan);
  const cleanupFile = path.join(folder, "source-cleanup.json");
  await writeJson(path.join(dir, cleanupFile), { ...plan.sourceCleanup, stage: "before-translation-and-qa", planVersion: plan.version });
  const unfinished = plan.units.filter((u) => u.boundaryKind === "fragment").map((u) => ({ unitId: u.block_id, pages: u.pages, ending: u.source.slice(-200) }));
  await writeJson(path.join(dir, folder, "boundary-audit.json"), { planVersion: plan.version,
    coverageVerified: true, sentenceBoundariesVerified: validateSentenceBoundaries(plan), unfinished,
    boundaries: plan.boundaries, normalizations: plan.normalizations, layoutClassifications: plan.layoutClassifications });
  manifest.source.normalizedFile = sourceFile;
  manifest.source.normalizedPlanFile = planFile;
  manifest.source.normalization = { version: plan.version, schemaVersion: plan.schemaVersion,
    joinedBoundaries: plan.boundaries.filter((b) => b.action === "join").length,
    joinedWords: plan.normalizations.length, unfinished: unfinished.length,
    removedMarkers: plan.sourceCleanup.removals.length, structuredNoteMarkers: plan.sourceCleanup.normalizations.length,
    preservedNoteMarkers: plan.sourceCleanup.callouts.length, cleanupFile };
  return plan;
}
