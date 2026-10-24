import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTranslationCheckpoint,unitIdentity } from '../src/translation-checkpoint.mjs';
import { writeJson,writeText,sha256,readJson } from '../src/utils.mjs';
import { structureMarkdown,parseStructuredMarkdown } from '../src/markdown.mjs';
import { buildTranslationPlan } from '../src/translation-plan.mjs';
import { languageSettings } from '../src/languages.mjs';
import { translateProject } from '../src/pipeline.mjs';
import { OpenAIClient } from '../src/openai-client.mjs';

test('explicitly adopted draft skips detection and translation, is included in QA, and rejects stale source identity',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'adopted-draft-')), dir=path.join(root,'projects/book');
 const savedEnv=Object.fromEntries(['OPENAI_API_KEY','OPENAI_MODEL','OPENAI_BASE_URL'].map(k=>[k,process.env[k]]));
 const originals=Object.fromEntries(['analyzeLanguages','translate','review','extractTerms'].map(k=>[k,OpenAIClient.prototype[k]]));
 const detected=[],translated=[],reviewed=[];
 try {
  process.env.OPENAI_API_KEY='mock';process.env.OPENAI_MODEL='mock';process.env.OPENAI_BASE_URL='http://unused.invalid/v1';
  const source=structureMarkdown('The operator was named Wei Lianyu.\n\nThe second paragraph remains to be translated.');
  const plan=buildTranslationPlan(parseStructuredMarkdown(source),1800), first=plan.units[0];
  const translation={block_id:first.block_id,translation:'这位收音员名叫 Wei Lianyu。',translator_notes:[],source_questions:[]};
  await writeText(path.join(dir,'approved.md'),source);
  for(const file of ['workflow.md','style-guide.md','glossary.md'])await writeText(path.join(dir,'00_shared',file),'test');
  await writeJson(path.join(root,'config/settings.json'),{openai:{model:'mock',baseUrl:process.env.OPENAI_BASE_URL,chunkMaxChars:85,unitMaxChars:1800,semanticQa:true,requestAttempts:1}});
  const content={sourceSha256:sha256(source),planVersion:plan.version,targetLanguage:'zh-Hans',entries:[{identity:unitIdentity(first),translation}]};
  const file='05_bilingual/adopted.json';await writeJson(path.join(dir,file),content);
  const manifest={projectId:'book',status:'translation_paused',languages:languageSettings(),source:{approvedFile:'approved.md',approvedSha256:sha256(source)},translationCheckpoint:{file,sha256:sha256(await readFile(path.join(dir,file),'utf8'))}};
  await writeJson(path.join(dir,'manifest.json'),manifest);
  const restored=await readTranslationCheckpoint(dir,manifest,plan,'zh-Hans');assert.equal(restored.translations[first.block_id].translation,translation.translation);
  await assert.rejects(readTranslationCheckpoint(dir,manifest,plan,'en'),/不匹配/);
  await assert.rejects(readTranslationCheckpoint(dir,manifest,{...plan,units:[{...first,source:'changed'},...plan.units.slice(1)]},'zh-Hans'),/定位/);
  const analyzedTerms=[];
  OpenAIClient.prototype.extractTerms=async function(bs){analyzedTerms.push(...bs.map(b=>b.block_id));return {value:{entries:[]}};};
  OpenAIClient.prototype.analyzeLanguages=async function(bs){
   assert.deepEqual(analyzedTerms,plan.units.map(b=>b.block_id),'all source, including adopted text, analyzed before translation');
   const current=await readJson(path.join(dir,'manifest.json'));assert.equal(current.openai.translatedChunks,1);
   detected.push(...bs.map(b=>b.block_id));return {value:{units:bs.map(b=>({block_id:b.block_id,segments:[{text:b.source,language:'en',reason:'English'}]}))}};
  };
  OpenAIClient.prototype.translate=async function(bs){translated.push(...bs.map(b=>b.block_id));return {value:{translations:bs.map(b=>({block_id:b.block_id,translation:'第二段译文。',source_questions:[],translator_notes:[]}))}};};
  OpenAIClient.prototype.review=async function(bs){reviewed.push(...bs.map(b=>b.block_id));return {value:{issues:[]}};};
  const result=await translateProject(dir,{root});
  assert.deepEqual(detected,[plan.units[1].block_id]);assert.deepEqual(translated,detected);
  assert.deepEqual(reviewed,plan.units.map(u=>u.block_id));assert.equal(result.manifest.openai.adoptedUnits,1);
  assert.match(await readFile(path.join(dir,'06_zh/project_zh.md'),'utf8'),/Wei Lianyu/);
  await writeText(path.join(dir,file),'{}');
  await assert.rejects(readTranslationCheckpoint(dir,manifest,plan,'zh-Hans'),/已变化/);
 } finally {
  for(const [key,value]of Object.entries(originals))OpenAIClient.prototype[key]=value;
  for(const [key,value]of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(root,{recursive:true,force:true,maxRetries:3});
 }
});
