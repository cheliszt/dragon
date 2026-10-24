// Group existing reading units without renumbering their translation caches or
// throwing away manual edits. Every old unit remains traceable in the revision.
export function joinReadingParts(units, side) {
  let text = '';
  const offsets = new Map();
  for (const unit of units) {
    const part = unit[side] || '';
    if (text && part && !/\s$/.test(text) && !/^\s/.test(part)) {
      if (side === 'source' ? !/[\u3400-\u9fff]$/.test(text) || !/^[\u3400-\u9fff]/.test(part)
        : /[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]$/u.test(text) && /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]/u.test(part)) text += ' ';
    }
    offsets.set(unit.id, text.length);
    text += part;
  }
  return { text, offsets };
}

export function applyReviewGrouping(model, grouping) {
  if (!grouping?.groups?.length) return model;
  const byId = new Map(model.units.map((u, i) => [u.id, { u, i }]));
  const replacements = new Map(), consumed = new Set(), blockMap = new Map();
  for (const group of grouping.groups) {
    const rows = group.unitIds.map(id => byId.get(id));
    if (rows.length < 2 || rows.some((r, i) => !r || r.u.artifact || consumed.has(r.u.id)
      || i && r.i !== rows[i - 1].i + 1)) throw new Error('段落合并必须覆盖连续且不重叠的现有单元。');
    const units = rows.map(r => r.u), first = units[0];
    const source = joinReadingParts(units, 'source').text;
    if (group.source !== source) throw new Error('段落合并的原文依据已变化。');
    const pages = [...new Set(units.flatMap(u => u.pages || [u.page]).filter(Boolean))];
    replacements.set(first.id, { ...first, source, target: joinReadingParts(units, 'target').text,
      pages, page: pages[0] || first.page, section: group.section || first.section,
      mergedFrom: group.unitIds, sourceSpans: group.sourceSpans,
      issueIds: group.issues ? group.issues.map(q => q.id) : [...new Set(units.flatMap(u => u.issueIds || []))], sourceMarks: [], targetMarks: [],
      languageSegments: undefined, languageReviews: units.flatMap(u => u.languageReviews || []),
      translatorNotes: units.flatMap(u => u.translatorNotes || []).map(n => ({ ...n, unitId: first.id, paragraphId: 'p1' })),
      termExceptions: units.flatMap(u => u.termExceptions || []), part: 1, parts: 1 });
    for (const u of units) { consumed.add(u.id); blockMap.set(u.blockId, first.blockId); }
  }
  return removeResolvedGroupingIssues({ ...model,
    units: model.units.filter(u => !consumed.has(u.id) || replacements.has(u.id)).map(u => replacements.get(u.id)
      || (grouping.unitSections?.[u.id] ? { ...u, section: grouping.unitSections[u.id] } : u)),
    issues: [...new Map([...model.issues, ...grouping.groups.flatMap(g => g.issues || [])].map(q => [q.id, q])).values()]
      .map(q => ({ ...q, blockIds: [...new Set((q.blockIds || []).map(id => blockMap.get(id) || id))] }))
  }, grouping);
}

export function groupedReviewChecks(checks, grouping) {
  const consumed = new Set((grouping?.groups || []).flatMap(g => g.unitIds));
  return { ...checks, units: Object.fromEntries(Object.entries(checks.units).filter(([id, check]) =>
    !consumed.has(id) || check.groupingVersion === grouping.version)) };
}

export function removeResolvedGroupingIssues(model, grouping) {
  const retired = new Set(grouping?.resolvedIssueIds || []);
  if (!retired.size) return model;
  return { ...model, issues: model.issues.filter(q => !retired.has(q.id)), units: model.units.map(u => ({ ...u,
    issueIds: u.issueIds.filter(id => !retired.has(id)),
    sourceMarks: u.sourceMarks.filter(m => !retired.has(m.issueId)), targetMarks: u.targetMarks.filter(m => !retired.has(m.issueId)) })) };
}

export function regroupAnnotationCatalog(catalog, model, grouping) {
  if (!catalog) return catalog;
  const next = structuredClone(catalog);
  for (const group of grouping.groups) {
    const units = group.unitIds.map(id => model.units.find(u => u.id === id));
    const { offsets } = joinReadingParts(units, 'source');
    for (const ref of next.references) if (offsets.has(ref.unitId)) {
      ref.sourceStart += offsets.get(ref.unitId); ref.sourceEnd += offsets.get(ref.unitId);
      ref.unitId = units[0].id;
    }
    for (const ref of next.unresolved || []) if (offsets.has(ref.unitId)) {
      if (Number.isInteger(ref.offset)) ref.offset += offsets.get(ref.unitId);
      ref.unitId = units[0].id;
    }
    for (const id of group.unitIds) delete next.paragraphMaps?.[id];
  }
  return next;
}
