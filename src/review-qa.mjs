import path from "node:path";
import { readJson, sha256 } from "./utils.mjs";
import { applyNumericPolicy } from "./numeric-qa.mjs";

export const qaDirectory = (dir, version) => path.join(dir, "04_qa/revisions", sha256(version));
export const qaUnitHash = (u) => sha256(JSON.stringify({ source: u.source, target: u.target }));
export async function readReviewChecks(dir, version) {
  try { return await readJson(path.join(qaDirectory(dir, version), "current.json")); }
  catch (e) { if (e.code !== "ENOENT") throw e; return { version, revision: 0, units: {} }; }
}

export function attachReviewChecks(base, model, checks) {
  const byId = new Map(base.units.map((u) => [u.id, u]));
  const currentHashes = new Map(model.units.map((u) => [u.id, qaUnitHash(u)]));
  const changedBlocks = new Set(base.units.filter((u) => currentHashes.get(u.id) !== qaUnitHash(u)).map((u) => u.blockId));
  const staleBaseIssues = new Set(base.issues.filter((q) => q.blockIds?.some((id) => changedBlocks.has(id))).map((q) => q.id));
  const issues = new Map(applyNumericPolicy(base.issues).map((q) => [q.id, { ...q }]));
  const marks = (text, own, side) => own.flatMap((q) => {
    const quote = side === "source" ? q.source_quote : q.translation_quote;
    if (!quote || !text.includes(quote)) return [];
    const result = []; let start = -1;
    while ((start = text.indexOf(quote, start + 1)) >= 0) result.push({ start, end: start + quote.length, issueId: q.id, exact: true });
    return result;
  });
  const units = model.units.map((unit) => {
    const old = byId.get(unit.id), check = checks.units[unit.id];
    const current = check ? check.basisHash === qaUnitHash(unit)
      && Object.entries(check.dependencies || {}).every(([id, hash]) => currentHashes.get(id) === hash)
      : old && qaUnitHash(old) === qaUnitHash(unit) && !(old.issueIds || []).some((id) => staleBaseIssues.has(id));
    const qa = { state: current ? "current" : "stale", basisRevision: check?.editRevision || 0,
      checkedAt: check?.checkedAt || null, basisTarget: check?.target ?? old?.target ?? "", basisHash: check?.basisHash || (old ? qaUnitHash(old) : "") };
    let own = check ? check.issues : (old?.issueIds || []).map((id) => issues.get(id)).filter(Boolean);
    own = applyNumericPolicy(own).map((q) => ({ ...q, stale: !current || q.stale, basisRevision: qa.basisRevision }));
    for (const q of own) issues.set(q.id, q);
    return { ...unit, qa, issueIds: own.map((q) => q.id),
      sourceMarks: current ? check ? marks(unit.source, own, "source") : unit.sourceMarks : [],
      targetMarks: current ? check ? marks(unit.target, own, "target") : unit.targetMarks : [] };
  });
  return { ...model, issues: [...issues.values()], units,
    qaRevision: checks.revision || 0, qaSummary: { current: units.filter((u) => !u.artifact && u.qa.state === "current").length,
      stale: units.filter((u) => !u.artifact && u.qa.state === "stale").length } };
}
