import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson,sha256,normalizeText,writeJson } from '../src/utils.mjs';
import { readTranslationCheckpoint } from '../src/translation-checkpoint.mjs';
import { validatePlanCoverage,validateSentenceBoundaries,endsSentence } from '../src/translation-plan.mjs';
import { translateProject } from '../src/pipeline.mjs';
import { OpenAIClient } from '../src/openai-client.mjs';

const dir=path.resolve(process.argv[2]);
let m=await readJson(path.join(dir,'manifest.json'));
const plan=await readJson(path.join(dir,m.source.normalizedPlanFile));
const input=await readJson(path.join(dir,'04_qa/boundary-repair/repair-input.json'));
const old=await readJson(path.join(dir,'05_bilingual/runs',input.oldPlan,'translation-plan.json'));
assert.equal(sha256(normalizeText(await readFile(path.join(dir,m.source.approvedFile),'utf8'))),m.source.approvedSha256);
assert.ok(validatePlanCoverage(plan));assert.ok(validateSentenceBoundaries(plan));
const checkpoint=await readTranslationCheckpoint(dir,m,plan,m.languages.targetLanguage);
const translations=plan.units.flatMap(u=>checkpoint.translations[u.block_id]?[checkpoint.translations[u.block_id]]:[]);
assert.equal(translations.length,m.translationCheckpoint.units);
const intervals=units=>{
 const grouped={};for(const u of units)for(const s of u.sourceSpans)(grouped[s.block_id]||=[]).push([s.start,s.end]);
 return Object.fromEntries(Object.entries(grouped).sort().map(([id,x])=>{
  x.sort((a,b)=>a[0]-b[0]);let last=0;for(const[a,b]of x){assert.equal(a,last,'Missing or duplicate source span '+id);last=b;}return[id,last];
 }));
};
assert.deepEqual(intervals(plan.units.slice(0,translations.length)),intervals(old.units.slice(0,401)));
const notes=new Set(plan.pdfLayout.footnotes.map(n=>n.block_id)),boundaryChecks=[];
for(const [i,u]of plan.units.slice(0,translations.length).entries()){
 const t=translations[i];assert.equal(t.block_id,u.block_id);
 if(u.section!=='注释与附录')assert.ok(u.sourceSpans.every(s=>!notes.has(s.block_id)),u.block_id+' note contamination');
 if(u.boundaryKind==='sentence'&&u.section==='正文'){
  assert.ok(endsSentence(u.source));assert.match(t.translation,/[。！？.!?][”’"'）)\]]*(?:\[\d+\]|\d+)?\s*$/u);
 }
 assert.ok(![...t.source_questions,...t.translator_notes].some(s=>/不挪入下一单元|不挪用下一单元|保留其未完状态|保留跨单元衔接|保留其续句形式|本单元末句.*中断/.test(s)),u.block_id+' stale interruption');
 boundaryChecks.push({unitId:u.block_id,pages:u.pages,kind:u.boundaryKind,section:u.section,sourceEnd:u.source.slice(-90),targetEnd:t.translation.slice(-90)});
}
for(const t of input.exact)assert.equal(checkpoint.translations[t.block_id].translation,t.translation,'Accepted prose preserved');
const next=plan.units[translations.length];let firstPendingRequest;
OpenAIClient.prototype.analyzeLanguages=async function(blocks){
 firstPendingRequest=blocks.map(b=>b.block_id);assert.equal(firstPendingRequest[0],next.block_id);
 assert.ok(firstPendingRequest.every(id=>!checkpoint.translations[id]));
 throw Object.assign(Error('离线接续验证完成，任务保持暂停。'),{code:'PAUSED'});
};
OpenAIClient.prototype.structuredRequest=async()=>{throw Error('External network disabled during verification');};
try{await translateProject(dir);}catch(e){if(e.code!=='PAUSED')throw e;}
assert.ok(firstPendingRequest);
m=await readJson(path.join(dir,'manifest.json'));
assert.equal(m.openai.adoptedUnits,translations.length);assert.equal(m.openai.translatedChunks,51);assert.equal(m.draft.translatedUnits,translations.length);
m.openai.request={state:'paused',phase:'translation',chunk:52,nextUnitId:next.block_id};delete m.error;delete m.errorDetails;
await writeJson(path.join(dir,'manifest.json'),m);
const base='http://127.0.0.1:4318',state=await(await fetch(base+'/api/state')).json();
const live=state.projects.find(p=>p.id===m.projectId);assert.equal(live.translation.translated,51);assert.equal(live.translation.total,139);
for(const kind of ['chinese','bilingual']){
 const response=await fetch(base+'/api/projects/'+m.projectId+'/file?kind='+kind);assert.equal(response.status,200);
 const text=await response.text();assert.match(text,/已保存 449\/1631/);assert.match(text,/兼做其他工作/);
 assert.match(text,/尚未生成译文：U000450/);assert.match(text,/作者原注/);assert.doesNotMatch(text,/要求县收音员——23/);
}
const result={verifiedAt:new Date().toISOString(),planVersion:plan.version,unitsChecked:translations.length,oldUnitsCovered:401,
 sourceCoverageExact:true,acceptedProseUnchanged:input.exact.length,footnoteIsolation:true,unitBoundariesChecked:true,
 liveDownloads:true,liveProgress:{translated:51,total:139},firstPendingRequest,externalApiCalls:0,firstUntranslated:next,boundaryChecks};
await writeJson(path.join(dir,'04_qa/boundary-repair/final-verification.json'),result);
console.log(JSON.stringify({...result,boundaryChecks:undefined,firstUntranslated:next.block_id}));
