import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { inspectPdfSourceLayout } from '../src/pdf-source-layout.mjs';
import { parseStructuredMarkdown, structureMarkdown } from '../src/markdown.mjs';
import { buildTranslationPlan, validatePlanCoverage, validateSentenceBoundaries } from '../src/translation-plan.mjs';

test('PDF typography separates notes with missing labels and joins the next page into the prior unfinished sentence', async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'pdf-boundary-'));
 try {
  const pdf=await PDFDocument.create(), first=pdf.addPage([612,792]), second=pdf.addPage([612,792]);
  const a='The local leaders proposed that county radio operators should';
  first.drawText('Earlier evidence supports this argument.23',{x:70,y:710,size:12});
  first.drawText(a,{x:70,y:400,size:12});
  first.drawText('23 HPA, A report, 1953.',{x:70,y:85,size:10});
  first.drawText('24 Ibid.',{x:70,y:60,size:10});
  second.drawText('perform additional duties beyond radio reception.',{x:70,y:710,size:12});
  const file=path.join(dir,'source.pdf');await writeFile(file,await pdf.save());
  const blocks=parseStructuredMarkdown(structureMarkdown('<!-- pdf_page: 1 -->\n\nEarlier evidence supports this argument.[^23]\n\n'+a+'\n\n23 HPA, A report, 1953.\n\nIbid.\n\n<!-- pdf_page: 2 -->\n\nperform additional duties beyond radio reception.'));
  const layout=await inspectPdfSourceLayout(file,blocks);
  assert.equal(layout.unmatched.length,0);
  assert.deepEqual(layout.footnotes.map(n=>n.label),['23','24']);
  const plan=buildTranslationPlan(blocks,25,{pdfLayout:layout});
  assert.ok(validatePlanCoverage(plan));assert.ok(validateSentenceBoundaries(plan));
  const joined=plan.units.find(u=>u.source.startsWith(a));
  assert.equal(joined.source,a+' perform additional duties beyond radio reception.');
  assert.deepEqual(joined.pages,[1,2]);
  assert.equal(joined.boundaryKind,'sentence');
  assert.ok(joined.source.length>25,'sentence completeness outranks the request size');
  assert.ok(plan.units.filter(u=>u.section==='正文').every(u=>!u.source.includes('HPA')));
  assert.deepEqual(plan.units.filter(u=>u.section==='注释与附录').map(u=>u.source),['23 HPA, A report, 1953.','Ibid.']);
 } finally {await rm(dir,{recursive:true,force:true});}
});
