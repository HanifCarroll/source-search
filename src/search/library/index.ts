import {sourceKind,isMail,connectedKinds} from '../../domain/source-catalog';
import { isProjected } from "../../domain/source-policy";
import { Database } from "bun:sqlite";
import { readFile, lstat, access } from "node:fs/promises";
import { join, relative, sep, isAbsolute, extname } from "node:path";
import {sourceEnabled, requireSource, sourceScope, sourceConfig, configuredSourceIds, type Config} from "../../platform/config";
import { libraryDB } from "./store";
import { archiveSignature, type ArchiveSource } from "../../sources/archives/originals";
import { runQmd, modelsPresent as checkModels, type QmdRun } from "../qmd/runner";
import { fail, hash, now, cursor, numberPosition, queryKey, assertVersion } from "../../domain/identity";
import { hit } from "../../domain/results";
import { regular } from "../../platform/source-files";
import { type Ref, type RecordData, type Query, type Page } from "../../domain/contracts";

export function projectionHealth(source:any,mail:boolean,at=Date.now()){
 const complete=source.state==='ready'||source.state==='refreshing'||!!source.lastCompleteScan;
 const activity=source.state==='backfilling'&&complete?'refreshing':source.state==='ready'?'idle':source.state;
 const lastCompletedAt=source.lastSuccessfulSync||source.lastCompleteScan;
 const ageSeconds=lastCompletedAt?Math.max(0,Math.floor((at-Date.parse(lastCompletedAt))/1000)):undefined;
 const stale=mail && ageSeconds!==undefined && ageSeconds>3600;
 const failed=source.state==='error'||!!source.failedFiles;
 return {...source,state:failed?'error':!complete?source.state:stale?'stale':'ready',activity,initialBackfillComplete:complete,freshness:{lastCheckedAt:source.checkedAt,lastCompletedAt,ageSeconds,stale}};
}
export async function libraryStatus(c:Config){
 if(!c.libraryEnabled || !sourceEnabled(c,"library"))return {available:false,state:"not-configured"};
 const modelsPresent = await checkModels(c);
 const db=libraryDB(c);
 try{
  const states=new Map((db.query("SELECT source,data FROM states").all() as any[]).map(r=>[r.source,JSON.parse(r.data)]));
  const sources=configuredSourceIds(c).filter(source=>sourceEnabled(c,source) && isProjected(source,c)).flatMap(source=>{
    const kind=sourceKind(source,c);
    const stage=kind.endsWith('-archive')?'archives':isMail(source,c)?'mail':kind==='documents'?'documents':kind==='tasks'||connectedKinds.includes(kind as typeof connectedKinds[number])?'snapshots':'native';
    const failure=states.get('maintenance-'+stage),saved=states.get(source);
    if(!saved && !failure)return [{source,state:'queued',records:0,chunks:0}];
    return [{source,...saved,...(failure?.state==='error'?{state:'error',error:failure.error,checkedAt:failure.checkedAt}:{})}];
  }).map(({source,state,records,textRecords,chunks,publishedAt,checkedAt,lastCompleteScan,lastSuccessfulSync,syncStrategy,coverage,error,failures,skipped,pending,discovered})=>projectionHealth({source,state,records,textRecords,chunks,publishedAt,checkedAt,lastCompleteScan,lastSuccessfulSync,syncStrategy,coverage,error,failedFiles:failures?.length||0,skippedFiles:skipped?.length||0,pending:Array.isArray(pending)?pending.length:pending,discovered},isMail(source,c)));
  let embeddings:any={ready:0,pending:0};const bySource:Record<string,any>={};
  try{await regular(c.libraryDatabase);const q=new Database(c.libraryDatabase,{create:false,strict:true});q.exec("PRAGMA query_only=ON");try{
    for(const row of q.query("SELECT collection,count(*) indexedDocuments,sum(EXISTS(SELECT 1 FROM content_vectors v WHERE v.hash=d.hash)) ready,sum(NOT EXISTS(SELECT 1 FROM content_vectors v WHERE v.hash=d.hash)) pending FROM documents d WHERE active=1 GROUP BY collection").all() as any[])bySource[row.collection.replace(/^ss-/,"")]=row;
   }finally{q.close();}}catch(e){embeddings={ready:0,pending:null,error:(e as Error).message};}
  if(!embeddings.error)embeddings=sources.reduce((a,s)=>{const e=bySource[s.source]||{};return {indexedDocuments:a.indexedDocuments+(e.indexedDocuments||0),ready:a.ready+(e.ready||0),pending:a.pending+(e.pending||0)};},{indexedDocuments:0,ready:0,pending:0});
  const available=(embeddings?.indexedDocuments||0)>0;
  return {available,state:!available?"building":sources.some(s=>s.state!=="ready") || embeddings.error || embeddings.pending?"partial":"ready",modelsPresent,sources:sources.map(s=>({...s,embeddings:bySource[s.source]||{indexedDocuments:0,ready:0,pending:null}})),embeddings,coverage:"Derived text with original references. Ranked discovery; inspect per-source backfill/freshness. Mail excludes spam/trash. Exports reflect selected snapshots."};
 }finally{db.close();}
}
export async function searchLibrary(c:Config,q:Query,execute:QmdRun=request=>runQmd(request,c)):Promise<Page>{
 requireSource(c,"library");requireSource(c,q.source);
 if(!c.libraryEnabled)fail("SOURCE_NOT_CONFIGURED","Library maintenance is not configured");
 if(!q.query.trim())fail("INVALID_QUERY","Library discovery requires a nonempty query");
 const mode=q.mode||"hybrid",status=await libraryStatus(c);
 if(!status.available)fail("SOURCE_NOT_READY","Initial library backfill has not produced searchable text yet");
 if(mode!=="lexical" && (!status.modelsPresent || !(q.source==="library"?status.embeddings?.ready:status.sources?.find(s=>s.source===q.source)?.embeddings?.ready)))fail("SOURCE_NOT_READY","Initial library embeddings are still building; lexical discovery is available after indexing");
 const raw=await execute({index:"library",mode,query:q.query,...(q.source!=="library"?{collection:"ss-"+q.source}:{})});
 if(!Array.isArray(raw))fail("INVALID_PROVIDER_RESPONSE","QMD returned invalid library results");
 await regular(c.libraryDatabase);const db=libraryDB(c),index=new Database(c.libraryDatabase,{create:false,strict:true});index.exec("PRAGMA query_only=ON");
 const records:RecordData[]=[],warnings=["Derived search text; read returned references for provenance and verify originals before citing. Ranked candidates are not exhaustive."];
 const scopes=status.sources?.filter(s=>q.source==="library"||s.source===q.source)||[];
 if(scopes.some(s=>s.state!=="ready"))warnings.push("Some selected sources have incomplete indexing, stale synchronization or failures; list_sources reports coverage and freshness.");
 const pendingEmbeddings=scopes.reduce((total,s)=>total+(s.embeddings.pending||0),0);
 if(pendingEmbeddings)warnings.push(`${pendingEmbeddings} selected library chunks await embeddings; semantic coverage is partial while the background job continues.`);
 try{for(const r of raw.slice(0,100)){
  if(typeof r.file!=="string"||typeof r.score!=="number")fail("INVALID_PROVIDER_RESPONSE","Invalid QMD hit");
  const m=/^qmd:\/\/ss-([a-z][a-z0-9-]*)\/([a-f0-9]{64})\.md$/.exec(r.file);
  if(!m || !sourceEnabled(c,m[1]!) || !isProjected(m[1]!,c) || q.source!=="library" && m[1]!==q.source)continue;
  const row=db.query("SELECT * FROM chunks WHERE id=? AND source=?").get(m[2]!,m[1]!) as any;
  const indexed=index.query("SELECT hash FROM documents WHERE active=1 AND collection=? AND path=?").get("ss-"+m[1],m[2]+".md") as any;
  if(row && JSON.parse(row.guard).scope!==sourceScope(c,row.source))continue;
  if(row && JSON.parse(row.guard).mail && JSON.parse(row.guard).accountSignature!==sourceScope(c,row.source))continue;
  if(!row || row.hash!==indexed?.hash){warnings.push("A changed/deleted projection is waiting for QMD refresh; its stale hit was withheld.");continue;}
  if(row.source==="documents"){
    try { for(const original of JSON.parse(row.refs) as Ref[])await readDocument(c,original); }
    catch { warnings.push("A document whose original is disabled, removed or changed was withheld.");continue; }
  }
  records.push({ref:{source:"library",id:row.id,version:row.hash},title:row.title,body:r.snippet||"",type:"derived-source-section",locator:"source-search://library/"+row.id,observedAt:now(),metadata:{sourceFamily:row.source,previewOnly:true,score:r.score,originalCount:JSON.parse(row.refs).length}});
 }}finally{db.close();index.close();}
 const key=queryKey(q)+hash(JSON.stringify(records.map(r=>r.ref))),start=numberPosition(q.cursor,key),selected=records.slice(start,start+q.limit);
 if(start>records.length)fail("STALE_CURSOR","Library results changed; restart the query");
 return {source:q.source,status:warnings.length>1?"partial":"ok",items:selected.map((r,i)=>{const item=hit(r,q,start+i+1);item.cursorAfter=cursor(key,start+i+1);item.metadata={...item.metadata,sourceFamily:r.metadata!.sourceFamily,originalCount:r.metadata!.originalCount};return item;}),...(start+selected.length<records.length?{nextCursor:cursor(key,start+selected.length)}:{}),warnings:[...new Set(warnings)],observedAt:now(),retrieval:{requestedMode:mode,effectiveMode:mode}};
}
async function matchesStamp(sig:any[]){
 const s=await lstat(sig[0],{bigint:true});
 return s.isFile() && !s.isSymbolicLink() && Number(s.size)===sig[1] && Number(s.mtimeNs)===sig[2] && Number(s.ctimeNs)===sig[3] && Number(s.ino)===sig[4];
}
export async function readDocument(c:Config,ref:Ref):Promise<RecordData>{
 requireSource(c,"documents");
 const inventory=JSON.parse(await readFile(join(c.libraryRoot,"documents.json"),"utf8"));
 const r=inventory.records.find((r:RecordData)=>r.ref.id===ref.id) as RecordData|undefined;
 if(!r)fail("STALE_RECORD","Extracted document is absent or awaiting refresh");assertVersion(ref,r.ref.version!);
 const origin=r.metadata!.origin as any;
 if([r.title,origin.path,origin.name].some(name=>typeof name==="string" && [".epub",".mobi",".azw",".azw3",".fb2",".djvu"].includes(extname(name).toLowerCase())))fail("SOURCE_EXCLUDED","Book format excluded from document indexing");
 if(origin.mailRef)requireSource(c,origin.mailRef.source);
 if(origin.source)requireSource(c,origin.source);
 if(origin.source && sourceKind(origin.source,c)==="takeout-archive" && !sourceConfig(c,origin.source).takeout.includes(origin.signature[0]))fail("SOURCE_DISABLED","Archive is no longer selected");
 if(origin.mailRef && origin.accountSignature!==sourceScope(c,origin.mailRef.source))fail("SOURCE_DISABLED","Attachment belongs to a previous account configuration");
 if(!origin.mailRef && !origin.source){
   const path=origin.path as string;
   if(!path || !c.documentRoots.some(root=>{const rel=relative(root,path);return rel!=="" && rel!==".." && !rel.startsWith(".."+sep) && !isAbsolute(rel);}))fail("SOURCE_DISABLED","Document root is no longer configured");
 }
 if(!await matchesStamp(origin.signature))fail("STALE_RECORD","Original document changed; automatic extraction is pending");
 if(origin.guardSignature && !await matchesStamp(origin.guardSignature))fail("STALE_RECORD","Attachment parent changed or was removed");
 for(const side of origin.signature.slice(5).filter(Array.isArray))if(!await matchesStamp(side))fail("STALE_RECORD","Original transcript sidecar changed");
 return r;
}
export async function readLibrary(c:Config,ref:Ref,validate:(r:Ref)=>Promise<unknown>):Promise<RecordData>{
 requireSource(c,"library");
 if(!/^[a-f0-9]{64}$/.test(ref.id))fail("INVALID_REFERENCE","Invalid library section");
 const db=libraryDB(c);let row:any;
 try{row=db.query("SELECT * FROM chunks WHERE id=?").get(ref.id);}finally{db.close();}
 if(!row)fail("STALE_RECORD","Library section was removed");assertVersion(ref,row.hash);
 requireSource(c,row.source);
 if(JSON.parse(row.guard).scope!==sourceScope(c,row.source))fail("SOURCE_DISABLED","Source configuration changed; rebuild or purge its previous projection");
 const refs=JSON.parse(row.refs) as Ref[],guard=JSON.parse(row.guard);
 if(guard.mail && guard.accountSignature!==sourceScope(c,guard.mail))fail("SOURCE_DISABLED","Projection belongs to a previous account configuration");
 if(guard.archive){if(guard.signature!==await archiveSignature(c,guard.archive as ArchiveSource))fail("STALE_RECORD","Selected original export changed; background rebuild is pending");}
 else for(const original of refs)await validate(original);
 return {ref:{...ref,version:row.hash},title:row.title,body:row.body,type:"derived-source-section",locator:"source-search://library/"+row.id,observedAt:now(),metadata:{sourceFamily:row.source,derived:true,originals:refs},warnings:["This is a labelled search projection. Original references were checked for freshness; use them to open complete source records. It is not an independent evidence source."]};
}
