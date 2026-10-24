// Conservative layout evidence for non-sentence text and interleaved PDF footnotes.
// All text remains in the translation plan; these classifications never delete words.
export function classifySourceStructure(blocks) {
  const pages = new Map();
  for (const block of blocks) {
    if (!block.page || block.kind === "artifact" || !block.text.trim()) continue;
    if (!pages.has(block.page)) pages.set(block.page, []);
    pages.get(block.page).push(block);
  }
  const structures = new Map(), footnotes = new Map();
  const folios = new Map();
  const romanValue = (text) => {
    const values = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    return [...text.toLowerCase()].reduce((sum, c, i, letters) => sum
      + (values[c] < (values[letters[i + 1]] || 0) ? -values[c] : values[c]), 0);
  };
  for (const [page, content] of pages) {
    const first = content[0], label = first.text.trim();
    if (!/^(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i.test(label)) continue;
    const delta = page - romanValue(label);
    if (!folios.has(delta)) folios.set(delta, []);
    folios.get(delta).push(first);
  }
  for (const sequence of folios.values()) {
    if (sequence.length >= 3) for (const b of sequence) structures.set(b.block_id, "roman-page-label");
  }
  for (const [page, content] of pages) {
    const pageText = content.map((b) => b.text).join("\n");
    // Restrict the cover rule to a short first page with explicit thesis submission metadata.
    if (page === 1 && pageText.length < 1800
      && /\b(?:thesis|dissertation) submitted\b/i.test(pageText)
      && /\b(?:degree|university)\b/i.test(pageText)) {
      for (const b of content) structures.set(b.block_id, "thesis-title-page");
    }
    const refs = new Set();
    let lastReference = -1;
    const label = (b) => b.text.match(/^(?:\[\^)?(\d{1,3})(?:\]|[.)])?(?:\s+|$)/)?.[1];
    content.forEach((b, index) => {
      // A note body can retain a structured label; it is not a new callout.
      if (/^\[\^\d+\]\s+(?:Ibid\b|See\b|HPA\b)/i.test(b.text)) return;
      for (const m of b.text.matchAll(/\[\^(\d{1,3})\](?!:)/g)) { refs.add(m[1]); lastReference = index; }
    });
    if (!refs.size || lastReference < 0) continue;
    const suffix = content.slice(lastReference + 1);
    const start = suffix.findIndex((b) => refs.has(label(b)));
    if (start < 0) continue;
    const notes = suffix.slice(start);
    const labels = notes.map(label).filter(Boolean);
    // Require consecutive, locally referenced labels and citation evidence at the page foot.
    // A single citation is sufficient when the same page explicitly references
    // its label; an unreferenced bare number is still insufficient evidence.
    if (!labels.length || labels.some((n, i) => !refs.has(n) || i && Number(n) !== Number(labels[i - 1]) + 1)
      || !notes.some((b) => /\b(?:18|19|20)\d{2}\b|\bIbid\b|https?:\/\//i.test(b.text))
      || notes.some((b) => /^\s*(?:#{1,6}\s|```|~~~|\||!\[)/.test(b.text))) continue;
    let current;
    for (const b of notes) {
      if (label(b)) current = `page-${page}-note-${label(b)}`;
      footnotes.set(b.block_id, current);
    }
  }
  for (const b of blocks) {
    if (/^落款[：:]\s*[^\n。！？]{1,50}$/.test(b.text.trim())) structures.set(b.block_id, "letter-signature");
  }
  return { structures, footnotes };
}
