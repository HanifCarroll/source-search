import {getMailState,setMailState} from '../platform/cache-state';
import {syncSources,snapshotSources} from './sources';
import {snapshotStore} from '../sources/sync/cache';
import {nativeCache} from './native-cache';
import {sourceFiles} from '../sources/local/notes';
import {syncMail as syncMailbox} from './mail';
import {withSourceLock} from './source-lock';
import {archiveInstances,archiveConfig} from './archives';
import {sourceKind,isMail} from '../domain/source-catalog';
import { isProjected } from "../domain/source-policy";
import {privateDirectory,privateJSON,markManagedCache} from "../platform/storage";
/** Explicit maintenance entry point. Never imported by the read-only MCP gateway. */
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig, sourceEnabled, requireMaintenance, configuredSourceIds, databasePath, mailAccount, sourceScope, sourceConfig, type Config } from "../platform/config";
import { allDatabaseRecords, databaseProjectionVersion } from "../sources/local/databases";
import { allMessageRecords } from "../sources/messages/index";
import { exportPaths, archiveSignature, exportProjectionVersion, type ArchiveSource } from "../sources/archives/originals";
import { rebuildArchive, indexStatus } from "../sources/archives/index";
import { run, type Run, type MailSource } from "../sources/mail/index";
import { hash, now, errorData, fail } from "../domain/identity";
import { libraryDB, getState, setState, publish } from "../search/library/store";

// Only consume committed snapshots. Publication failure cannot roll back a
// provider checkpoint, and a failed sync keeps its previous searchable records.
export async function publishSnapshots(c:Config){
 requireMaintenance(c);
 if(!c.libraryEnabled||!sourceEnabled(c,'library'))return;
 await privateDirectory(c.libraryRoot);
 const db=libraryDB(c,true);
 try{for(const source of snapshotSources(c)){
  try{
   const saved=await snapshotStore(c,source).read();
   if(!saved)fail('NEEDS_SYNC','Run sync-sources to load this source before indexing it');
   await publish(c,source,saved.records,{snapshot:source},{state:saved.lastError?'error':'ready',error:saved.lastError||null,checkedAt:saved.lastAttemptAt||saved.checkedAt,lastSuccessfulSync:saved.checkedAt,syncStrategy:saved.strategy,coverage:saved.coverage});
  }catch(e){setState(db,source,{...getState(db,source),state:'error',error:errorData(e),checkedAt:now()});}
 }}finally{db.close();}
}

export async function stampPaths(paths:string[]){const values=[];for(const p of paths){try{const s=await lstat(p);values.push([p,s.size,s.mtimeMs,s.ctimeMs,s.ino]);}catch(e){if((e as any).code!=="ENOENT")throw e;values.push([p,null]);}}return hash(JSON.stringify(values));}
async function native(c:Config){
 const db=libraryDB(c,true);
 try{
  for(const source of configuredSourceIds(c).filter(id=>["muesli","messages","whatsapp"].includes(sourceKind(id,c)))){
   try{
    if(!sourceEnabled(c,source))continue;
    const kind=sourceKind(source,c), scoped=sourceConfig(c,source),path=kind==="messages"?scoped.messages:databasePath(c,source),paths=[path,path+"-wal"],signature=await stampPaths(paths);
    const projectionVersion=kind==="messages" ? 1 : databaseProjectionVersion(source,c);
    if(getState(db,source).signature===signature && (getState(db,source).projectionVersion||1)===projectionVersion && getState(db,source).scope===sourceScope(c,source) && getState(db,source).state!=="error"){setState(db,source,{...getState(db,source),checkedAt:now()});continue;}
    const cache=nativeCache(db,source,projectionVersion+sourceScope(c,source));
    const records=kind==="messages"?(await allMessageRecords(scoped,cache.reuse)).map(r=>({...r,...(source!==kind?{adapter:kind}:{}),ref:{...r.ref,source}})):await allDatabaseRecords(c,source,cache.reuse);
    if(signature!==await stampPaths(paths))throw Error("Source changed during snapshot; retaining previous projection and retrying");
    await publish(c,source,records,{paths},{signature,scope:sourceScope(c,source),projectionVersion,syncStrategy:"snapshot-row-diff",state:"ready",error:null,checkedAt:now(),coverage:"Current local database; absent text and phone-only history cannot be recovered"});
    setState(db,source,{...getState(db,source),lastSuccessfulSync:now(),incremental:cache.commit()});
   }catch(e){setState(db,source,{...getState(db,source),state:"error",error:errorData(e),checkedAt:now()});}
  }
 }finally{db.close();}
}
async function archives(c:Config){
 const db=libraryDB(c,true);
 try {for(const source of archiveInstances(c)) {
  const kind=sourceKind(source,c) as ArchiveSource,scoped=source===kind?c:archiveConfig(c,source);
  if(!exportPaths(scoped,kind).length){setState(db,source,{state:"waiting-for-export",records:0,chunks:0});continue;}
  try {
   const paths:string[]=[];
   for(const p of exportPaths(scoped,kind)){const s=await lstat(p);if(s.isDirectory())paths.push(...(await sourceFiles(p,()=>true)).paths.map(name=>join(p,name)));else paths.push(p,p+'-wal');}
   const fileStamp=await stampPaths(paths),previous=getState(db,source),projectionVersion=exportProjectionVersion(kind),scope=sourceScope(c,source);
   if(previous.fileStamp===fileStamp && previous.scope===scope && previous.projectionVersion===projectionVersion && previous.state==='ready'){setState(db,source,{...previous,checkedAt:now()});continue;}
   const signature=await archiveSignature(c,source);
   let state:any;try{state=JSON.parse((await indexStatus(scoped))[kind]||'{}');}catch{state={};}
   if(state.signature!==signature||state.projectionVersion!==projectionVersion)await rebuildArchive(scoped);
   if(previous.signature===signature&&previous.scope===scope&&previous.projectionFormat===2&&previous.projectionVersion===projectionVersion&&previous.state!=="error"){setState(db,source,{...previous,fileStamp,checkedAt:now()});continue;}
   const index=new Database(scoped.index,{readonly:true});
   try {
    const records=(index.query("SELECT data,body FROM records WHERE source=? ORDER BY id").all(kind) as any[]).map(r=>{const record={...JSON.parse(r.data),body:r.body};record.ref.source=source;if(source!==kind)record.adapter=kind;return record;});
    await publish(c,source,records,{archive:source,signature},{projectionFormat:2,projectionVersion,signature,fileStamp,scope,syncStrategy:"changed-export",state:"ready",error:null,checkedAt:now(),coverage:"Selected export snapshot only; no automatic account export"});
   }finally{index.close();}
  }catch(e){setState(db,source,{...getState(db,source),state:"error",error:errorData(e),checkedAt:now()});}
 }}finally{db.close();}
}
// The source worker owns mail checkpoints. Library publication consumes the
// committed cache under the same source lock, including deferred dirty records.
async function publishCachedMail(c:Config,db:Database,source:string){
 const state=getMailState(db,source),projection=getState(db,source);
 if(!state.accountSignature || state.accountSignature!==sourceScope(c,source))return;
 // Copy a legacy checkpoint before publication replaces its old mixed row.
 setMailState(db,source,state);
 const freshness={state:state.state,error:state.error,checkedAt:state.checkedAt,lastCompleteScan:state.lastCompleteScan,
  lastSuccessfulSync:state.lastSuccessfulSync,syncStrategy:state.syncStrategy,coverage:state.coverage};
 if(state.dirty || !projection.publishedAt){
  const records=(db.query('SELECT data FROM mail WHERE source=? ORDER BY id').all(source) as {data:string}[]).map(r=>JSON.parse(r.data));
  await publish(c,source,records,{mail:source,accountSignature:sourceScope(c,source)},freshness);
  setMailState(db,source,{...state,dirty:false});
 }else setState(db,source,{...projection,...freshness});
}
export async function syncMail(c:Config,execute:Run=run,sources:readonly MailSource[]=configuredSourceIds(c).filter(id=>isMail(id,c))){return syncMailbox(c,execute,sources,publishCachedMail);}
export async function publishMail(c:Config){
 requireMaintenance(c);
 if(!c.libraryEnabled||!sourceEnabled(c,'library'))return;
 for(const source of configuredSourceIds(c).filter(id=>sourceEnabled(c,id)&&isMail(id,c))){
  await withSourceLock(c,'mail-'+source,async()=>{const db=libraryDB(c,true);try{await publishCachedMail(c,db,source);}finally{db.close();}});
 }
}
async function documents(c:Config){
 if(!sourceEnabled(c,"documents"))return;
 const temporaryConfig=join(c.libraryRoot,"extraction-config.json");
 await privateJSON(temporaryConfig,{...c,mailAccounts:Object.fromEntries(configuredSourceIds(c).filter(id=>isMail(id,c)).map(id=>[id,mailAccount(c,id)]))});
 try{
  const child=Bun.spawn([c.extractorPython,join(import.meta.dir,"../../scripts/extract-documents.py"),"--config",temporaryConfig],{stdin:"ignore",stdout:"inherit",stderr:"inherit",env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:temporaryConfig}});
  if(await child.exited)throw Error("Document extraction failed; see private maintenance log");
 }finally{await rm(temporaryConfig,{force:true});}
 const inventory=JSON.parse(await readFile(join(c.libraryRoot,"documents.json"),"utf8"));
 await publish(c,"documents",inventory.records,{documents:true},{state:inventory.pending?"backfilling":inventory.failures.length?"partial":"ready",pending:inventory.pending,discovered:inventory.discovered,failures:inventory.failures,skipped:inventory.skipped,checkedAt:now(),coverage:"Configured local roots, cached mail and selected Takeout attachments; document text, OCR and local transcription; skipped inputs include PDFs over the page budget and files with no detected text or audio"});
}
export async function syncLibrary(c:Config,{refreshSources=true}={}){
 requireMaintenance(c);
 if(!c.libraryEnabled || !sourceEnabled(c,"library"))return;
 if(refreshSources)await syncSources(c);
 await markManagedCache(c.libraryRoot);await privateDirectory(c.libraryRoot);await privateDirectory(join(c.libraryRoot,"mail-raw"));
 const db=libraryDB(c,true);for(const source of configuredSourceIds(c).filter(s=>sourceEnabled(c,s) && isProjected(s,c)))if(!getState(db,source).state)setState(db,source,{state:"queued",records:0,chunks:0});db.close();
 // Independent source failures are recorded without starving healthy sources.
 for(const [name,work] of [["native",native],["archives",archives],["snapshots",publishSnapshots],["mail",publishMail],["documents",documents]] as const){
  try{await work(c);const d=libraryDB(c,true);d.query("DELETE FROM states WHERE source=?").run("maintenance-"+name);d.close();}catch(e){const d=libraryDB(c,true);setState(d,"maintenance-"+name,{state:"error",error:errorData(e),checkedAt:now()});d.close();}
 }
 const cleaned=libraryDB(c,true);try{cleaned.query("DELETE FROM states WHERE source IN ('maintenance-tasks','maintenance-connected')").run();}finally{cleaned.close();}
}
if(import.meta.main){process.umask(0o077);await syncLibrary(await loadConfig());console.log(JSON.stringify({ok:true,checkedAt:now()}));}
