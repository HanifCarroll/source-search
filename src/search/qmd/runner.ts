import {access,mkdir,lstat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Config} from '../../platform/config';
import {configuredSourceIds,sourceEnabled,sourceScope} from '../../platform/config';
import {packageRoot} from '../../platform/package-root';
import {isProjected} from '../../domain/source-policy';
import {libraryDB,getState} from '../library/store';
import {fail,hash} from '../../domain/identity';
import {qmdIndex} from '../../vendor/qmd';
import {trackIndexRevision} from '../../vendor/qmd/revisions';
import worker from './sdk.mjs' with {type:'text'};
import {cachedSearch} from './cache';
import {JsonWorker} from '../../platform/json-worker';
import type {Query} from '../../domain/contracts';
export type QmdRequest={index:'vault'|'library';mode:'lexical'|'semantic'|'hybrid';query:string;collection?:string;plan?:Query['plan'];depth?:Query['depth']};
export type QmdRun=(request:QmdRequest)=>Promise<unknown>;
const workers=new Map<string,{identity:string;client:JsonWorker}>();
export function disposeSearchWorkers(){for(const worker of workers.values())worker.client.close();workers.clear();}
export function searchModels(c:Config) {
  if(c.searchModels)return c.searchModels;
  const find=(pattern:RegExp)=>c.qmdModels.find(p=>pattern.test(p));
  const embed=find(/embedding|embed/i),rerank=find(/rerank/i),generate=find(/expansion|generate|expand/i);
  return embed&&rerank&&generate?{embed,rerank,generate}:undefined;
}
export async function modelsPresent(c:Config){const models=c.searchModels?Object.values(c.searchModels):c.qmdModels;return models.length===3 && (await Promise.all(models.map(p=>access(p).then(()=>true,()=>false)))).every(Boolean);}
export function searchCollections(c:Config,index:'vault'|'library'){
 return Object.fromEntries(index==='vault'?Object.entries(c.qmdRoots).map(([id,path])=>[id,{path,pattern:'**/*.md'}]):configuredSourceIds(c).filter(s=>sourceEnabled(c,s)&&isProjected(s,c)).map(s=>['ss-'+s,{path:join(c.libraryRoot,'collections','ss-'+s),pattern:'**/*.md'}]));
}
export async function runSdk(c:Config,request:Omit<Partial<QmdRequest>,'index'> & {index:'vault'|'library';action?:'update'|'embed'|'status'},signal?:AbortSignal):Promise<any>{
 const database=request.index==='library'?c.libraryDatabase:c.qmdDatabase,models=searchModels(c);
 if(request.action==='embed'||!request.action && request.mode!=='lexical')if(!models || !await modelsPresent(c))fail('MODELS_NOT_CONFIGURED','Run setup and configure installed searchModels before semantic search or embedding');
 if(request.action==='update')await mkdir(dirname(database),{recursive:true,mode:0o700});else await access(database).catch(()=>fail('SOURCE_NOT_READY','Search index is missing; run source-search index'));
 const collections=searchCollections(c,request.index);
 if(!request.action && request.mode!=='lexical'){
  const names=request.collection?[request.collection]:Object.keys(collections);
  if(!names.length)fail('SOURCE_NOT_CONFIGURED','No enabled search collections');
  const index=qmdIndex(database);
  try{index.assertEmbeddingModel(names,models!.embed);}finally{index.close();}
 }
 if(request.action==='update')for(const [name,collection] of Object.entries(collections)){
  const info=await lstat(collection.path).catch(error=>{if(request.index==='library' && error.code==='ENOENT')return undefined;throw error;});
  if(!info){delete collections[name];continue;}
  if(!info.isDirectory()||info.isSymbolicLink())fail('SOURCE_UNAVAILABLE','Collection root is unavailable; retaining the previous index');
 }
 let projectionSignature:string|undefined;
 if(request.action==='update' && request.index==='library'){
  try{const db=libraryDB(c);try{projectionSignature=hash(JSON.stringify([1,collections,Object.keys(collections).sort().map(name=>{const source=name.slice(3),s=getState(db,source);return [source,s.projectionRevision||s.publishedAt,sourceScope(c,source)];})]));}finally{db.close();}}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 const modelStamps=await Promise.all(Object.values(models||{}).map(async p=>{const s=await lstat(p).catch(e=>{if(e.code!=='ENOENT')throw e;return undefined;});return [p,s?.size,s?.mtimeMs,s?.ctimeMs];}));
 const codeStamps=await Promise.all(['src/search/qmd/reranker.ts','src/search/qmd/mlx_ranker.py','src/search/qmd/pipeline.ts','src/search/qmd/text-ranker.ts','src/search/qmd/onnx_ranker.py','scripts/acceleration-requirements.txt'].map(async p=>{const s=await lstat(join(packageRoot,p));return [p,s.size,s.mtimeMs];}));
 const rankerStamps=c.searchRanker?await Promise.all([c.searchRanker.file,'config.json','tokenizer.json'].map(async p=>{const s=await lstat(join(c.searchRanker!.directory,p)).catch(e=>{if(e.code!=='ENOENT')throw e;return undefined;});return [p,s?.size,s?.mtimeMs,s?.ctimeMs];})):undefined;
 const lock=await lstat(join(packageRoot,'bun.lock'));
 const scopes=configuredSourceIds(c).filter(s=>sourceEnabled(c,s)).map(s=>[s,sourceScope(c,s)]);
 const identity={collections,models:modelStamps,acceleration:c.searchAcceleration,ranker:c.searchRanker,rankerStamps,codeStamps,scopes,sdk:worker,dependency:[lock.size,lock.mtimeMs]};
 const perform=async()=>{
   const input={...request,database,models,collections,projectionSignature,acceleration:c.searchAcceleration,ranker:c.searchRanker,
     rerankerUrl:pathToFileURL(join(packageRoot,'src/search/qmd/reranker.ts')).href,
     textRankerUrl:pathToFileURL(join(packageRoot,'src/search/qmd/text-ranker.ts')).href,
     pipelineUrl:pathToFileURL(join(packageRoot,'src/search/qmd/pipeline.ts')).href,
     inferenceRevision:hash(JSON.stringify([3,modelStamps,c.searchAcceleration,c.searchRanker,rankerStamps,codeStamps])),sdkUrl:pathToFileURL(Bun.resolveSync('@tobilu/qmd',packageRoot)).href};
   const dbStamp=await lstat(database).catch(e=>{if(e.code!=='ENOENT')throw e;return undefined;});
   const key=hash(JSON.stringify([identity,dbStamp?.dev,dbStamp?.ino]));
   const existing=workers.get(database);
   if(request.action||existing?.identity!==key){existing?.client.close();workers.delete(database);}
   const persistent=!request.action&&(workers.has(database)||workers.size<4);
   const client=workers.get(database)?.client || new JsonWorker([c.bunBinary,'--input-type=module','--eval',worker+'\nawait main();'],{
     env:{HF_HUB_OFFLINE:'1',QMD_RERANK_CONTEXT_SIZE:'4096',QMD_EMBED_PARALLELISM:'1',...(process.platform==='darwin'&&process.env.QMD_METAL_KEEP_RESIDENCY!=='1'?{GGML_METAL_NO_RESIDENCY:'1'}:{})},
   });
   if(persistent)workers.set(database,{identity:key,client});
   try{return await client.request(input,{signal,timeoutMs:request.action==='embed'?1800000:request.action==='update'?600000:240000});}
   catch(error){fail(signal?.aborted?'CANCELLED':'QMD_FAILED',(error as Error).message);}
   finally{if(!persistent)client.close();}
 };

 if(request.action){
  const result=await perform();
  if(request.action!=='status')trackIndexRevision(database);
  return result;
 }
 return cachedSearch(database,{request,...identity},perform);
}
export const runQmd=(request:QmdRequest,c:Config,signal?:AbortSignal)=>runSdk(c,request,signal);
