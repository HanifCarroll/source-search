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
export type QmdRequest={index:'vault'|'library';mode:'lexical'|'semantic'|'hybrid';query:string;collection?:string};
export type QmdRun=(request:QmdRequest)=>Promise<unknown>;
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
export async function runSdk(c:Config,request:{index:'vault'|'library';action?:'update'|'embed'|'status';mode?:QmdRequest['mode'];query?:string;collection?:string}):Promise<any>{
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
 const acceleratorStamps=c.searchAcceleration?await Promise.all(['src/search/qmd/reranker.ts','src/search/qmd/mlx_ranker.py','scripts/acceleration-requirements.txt'].map(async p=>{const s=await lstat(join(packageRoot,p));return [p,s.size,s.mtimeMs];})):undefined;
 const perform=async()=>{
 const input=JSON.stringify({...request,database,models,collections,projectionSignature,acceleration:c.searchAcceleration,rerankerUrl:pathToFileURL(join(packageRoot,'src/search/qmd/reranker.ts')).href,inferenceRevision:hash(JSON.stringify([2,modelStamps,c.searchAcceleration,acceleratorStamps])),sdkUrl:pathToFileURL(Bun.resolveSync('@tobilu/qmd',packageRoot)).href});
 const child=Bun.spawn([c.bunBinary,'--input-type=module','--eval',worker+'\nawait main();'],{stdout:'pipe',stderr:'pipe',stdin:new Blob([input]),env:{...process.env,HF_HUB_OFFLINE:'1',QMD_RERANK_CONTEXT_SIZE:'4096',QMD_EMBED_PARALLELISM:'1',...(process.platform==='darwin'&&process.env.QMD_METAL_KEEP_RESIDENCY!=='1'?{GGML_METAL_NO_RESIDENCY:'1'}:{})}});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const bounded=async(stream:ReadableStream<Uint8Array>)=>{let bytes=0;const chunks:Uint8Array[]=[];for await(const part of stream){bytes+=part.length;if(bytes>4*1024*1024){child.kill();fail('OUTPUT_LIMIT','Search worker exceeded its output budget');}chunks.push(part);}return Buffer.concat(chunks).toString();};
 try{return await Promise.race([
  (async()=>{const [out,err,code]=await Promise.all([bounded(child.stdout),bounded(child.stderr),child.exited]);if(code)fail('QMD_FAILED',`Search worker failed (${code}): ${err.slice(-900)}`);const line=out.split('\n').findLast(s=>s.startsWith('SOURCE_SEARCH_RESULT '));if(!line)fail('INVALID_PROVIDER_RESPONSE','Search worker returned no result');return JSON.parse(line.slice(21));})(),
  new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Search worker timed out; retry or narrow the request'),{code:'TIMEOUT'}));},request.action==='embed'?1800000:request.action==='update'?600000:240000);})
 ]);}finally{clearTimeout(timer);}
 };
 if(request.action){
  const result=await perform();
  if(request.action!=='status')trackIndexRevision(database);
  return result;
 }
 const scopes=configuredSourceIds(c).filter(s=>sourceEnabled(c,s)).map(s=>[s,sourceScope(c,s)]);
 const lock=await lstat(join(packageRoot,'bun.lock'));
 return cachedSearch(database,{request,collections,models:modelStamps,acceleration:c.searchAcceleration,acceleratorStamps,scopes,sdk:worker,dependency:[lock.size,lock.mtimeMs]},perform);
}
export const runQmd=(request:QmdRequest,c:Config)=>runSdk(c,request);
