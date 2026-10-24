import { openPdf } from './pdf-text.mjs';
import { readingBlocks } from './reading-text.mjs';
import { sha256 } from './utils.mjs';

export const PDF_LAYOUT_VERSION = 1;
const compact = (s) => s.normalize('NFKC').replace(/\[\^(\d+)\]/g, '$1').replace(/^#{1,6}\s/gm, '').replace(/\s/g, '');

// Match the approved text to PDF glyphs, not to a new transcription. Unmatched
// text never acquires inferred layout. Font and position evidence is auditable.
export async function inspectPdfSourceLayout(file, sourceBlocks) {
  const blocks = readingBlocks(sourceBlocks);
  const task = await openPdf(file);
  try {
    const pdf = await task.promise, records = [], unmatched = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), { items } = await page.getTextContent();
      let text = ''; const ranges = [];
      for (const item of items) {
        const str = compact(item.str || '');
        ranges.push({ start: text.length, end: text.length + str.length,
          h: Math.abs(item.height || item.transform?.[3] || 0), y: item.transform?.[5] });
        text += str;
      }
      let cursor = 0;
      for (const b of blocks.filter((b) => b.page === number && b.kind !== 'artifact')) {
        const target = compact(b.text), index = text.indexOf(target, cursor);
        if (index < 0) { unmatched.push(b.block_id); continue; }
        const heights = {}, hit = ranges.filter((r) => r.end > index && r.start < index + target.length);
        for (const r of hit) {
          const count = Math.min(index + target.length, r.end) - Math.max(index, r.start);
          heights[r.h.toFixed(1)] = (heights[r.h.toFixed(1)] || 0) + count;
        }
        const preceding = text.slice(cursor, index);
        const label = b.text.match(/^(?:\[\^)?(\d{1,3})(?:\]|[.)])?(?:\s|$)/)?.[1]
          || (/^\d{1,3}$/.test(preceding) ? preceding : null);
        records.push({ block_id: b.block_id, page: number, heights,
          height: page.view[3] - page.view[1], yTop: Math.max(...hit.map((r) => r.y)) - page.view[1],
          yBottom: Math.min(...hit.map((r) => r.y)) - page.view[1], label, text: b.text });
        cursor = index + target.length;
      }
      page.cleanup();
    }
    const footnotes = [];
    let previousNote = null;
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = records.filter((r) => r.page === number);
      const fonts = new Map();
      for (const r of content.filter((r) => r.yTop > r.height * .5)) for (const [h, count] of Object.entries(r.heights)) fonts.set(Number(h), (fonts.get(Number(h)) || 0) + count);
      const body = [...fonts].sort((a,b) => b[1]-a[1])[0]?.[0];
      if (!body) continue;
      const isNote = (r) => r.yTop < r.height * .55 && Object.entries(r.heights).filter(([h]) => Number(h) < body * .9).reduce((sum,[,n]) => sum+n,0) >= Object.values(r.heights).reduce((sum,n) => sum+n,0) * .9;
      let start = content.length;
      while (start > 0 && isNote(content[start-1])) start--;
      if (start === content.length || !start) continue;
      const suffix = content.slice(start);
      // At least one numbered note or a continuation from the immediately prior
      // page is required; a small caption alone does not become a footnote.
      if (!suffix.some((r) => r.label) && previousNote?.page !== number-1) continue;
      let note = null;
      for (const r of suffix) {
        if (r.label) note = { id: `pdf-page-${number}-note-${r.label}`, label: r.label, page: number };
        else if (!note) note = previousNote?.page === number-1 ? { ...previousNote, page: number } : { id: `pdf-page-${number}-unlabelled-note`, page: number };
        footnotes.push({ block_id: r.block_id, noteId: note.id, label: note.label || null,
          page: number, evidence: 'matched-pdf-small-type-page-foot', bodyFont: body, heights: r.heights, yTop: r.yTop, yBottom: r.yBottom });
        previousNote = note;
      }
    }
    return { schemaVersion: PDF_LAYOUT_VERSION, sourceDigest: sha256(JSON.stringify(sourceBlocks)),
      mappedBlocks: records.length, unmatched, footnotes };
  } finally { await task.destroy(); }
}
