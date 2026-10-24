// Shared by the browser and approval gate so every blocking marker is discoverable.
export function findSourceIssues(text) {
  const issues = [];
  const tokens = /<!--\s*block_id:\s*([A-Za-z0-9._:-]+)\s*-->|<!--\s*pdf_page:\s*(\d+)|\b(TODO|CHECK-SOURCE|UNCERTAIN)\b/g;
  let blockId = null, page = null, line = 1, previousOffset = 0;
  for (const match of text.matchAll(tokens)) {
    line += (text.slice(previousOffset, match.index).match(/\n/g) || []).length;
    previousOffset = match.index;
    if (match[1]) { blockId = match[1]; continue; }
    if (match[2]) { page = Number(match[2]); continue; }
    const start = match.index, end = start + match[0].length;
    const lineEnd = text.indexOf("\n", end);
    const reason = text.slice(end, lineEnd < 0 ? text.length : lineEnd).replace(/-->[\s\S]*$/, "").replace(/^\s*[:：]?\s*/, "").trim();
    const context = text.slice(Math.max(0, start - 180), Math.min(text.length, end + 420))
      .replace(/<!--[\s\S]*?-->/g, " ").replace(/\n[ \t\r]*\n(?:[ \t\r]*\n)*/g, "\n\n").trim();
    issues.push({ marker: match[3], start, end, blockId, page, line, reason, context });
  }
  return issues;
}

export function resolveSourceIssue(text, issue) {
  const current = findSourceIssues(text).find((item) => item.start === issue.start && item.marker === issue.marker);
  if (!current) throw new Error("原文已变化，请重新选择待核对项。");
  // Remove the generated warning clause, retaining the page and block anchors.
  const commentStart = text.lastIndexOf("<!--", current.start);
  const commentEnd = text.indexOf("-->", current.end);
  const prefix = text.slice(commentStart, current.start);
  const suffix = text.slice(current.end, commentEnd);
  if (commentStart >= 0 && commentEnd >= 0 && current.marker === "CHECK-SOURCE"
      && /^<!--\s*pdf_page:\s*\d+\s*;\s*$/.test(prefix)
      && /^:[^;\r\n]*$/.test(suffix) && !/\b(?:TODO|CHECK-SOURCE|UNCERTAIN)\b/.test(suffix)) {
    const clauseStart = commentStart + prefix.indexOf(";");
    return text.slice(0, clauseStart).trimEnd() + " " + text.slice(commentEnd);
  }
  // Unknown marker formats: remove only the selected token, never surrounding source text.
  return text.slice(0, current.start) + text.slice(current.end);
}
