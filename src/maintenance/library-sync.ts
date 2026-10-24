import {nativeCache} from './native-cache';
import {sourceFiles} from '../sources/local/notes';
import {syncNativeMail,syncGmailChanges,gmailAnchor} from './mail-sync';
import {archiveInstances,archiveConfig} from './archives';
import {sourceKind,isMail} from '../domain/source-catalog';
import { isProjected } from "../domain/source-policy";
import {privateDirectory,markManagedCache} from "../platform/storage";
/** Explicit maintenance entry point. Never imported by the read-only MCP gateway. */
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig, sourceEnabled, requireMaintenance, configuredSourceIds, databasePath, mailAccount, sourceScope, sourceConfig, type Config } from "../platform/config";
import { allDatabaseRecords, databaseProjectionVersion } from "../sources/local/databases";
import { allMessageRecords } from "../sources/messages/index";
import { exportPaths, archiveSignature, exportProjectionVersion, type ArchiveSource } from "../sources/archives/originals";
import { rebuildArchive, indexStatus } from "../sources/archives/index";
import { readMail, searchMail, formatMail, connector, run, type Run, type MailSource } from "../sources/mail/index";
import { hash, now, errorData } from "../domain/identity";
import { type Query } from "../domain/contracts";
import { libraryDB, getState, setState, publish, privateJSON } from "../search/library/store";

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
export async function syncMail(c:Config,execute:Run=run,sources:readonly MailSource[]=configuredSourceIds(c).filter(id=>isMail(id,c))){
 requireMaintenance(c);
 const db=libraryDB(c,true);
 try{for(const source of sources){
  if(!sourceEnabled(c,source))continue;
  let state=getState(db,source),changed=false;
  const accountSignature=sourceScope(c,source);
  try{
   if(state.accountSignature && state.accountSignature!==accountSignature)throw Error("Mail account or provider changed; use a new source ID or purge this source cache");
   if(state.projectionVersion!==2){
    // Re-project existing provider responses locally; unchanged summaries must
    // not leave HTML bodies in an older format or trigger a full account fetch.
    const cached=db.query("SELECT id FROM mail WHERE source=? ORDER BY id").all(source) as {id:string}[];
    for(const {id} of cached){
     const saved=JSON.parse(await readFile(join(c.libraryRoot,"mail-raw",source+"-"+(id.length>180?hash(id):id)+".json"),"utf8"));
     if(saved.source!==source || saved.id!==id || saved.accountSignature!==accountSignature)throw Error("Cached mail identity does not match the configured account");
     const kind=sourceKind(source,c);
     const record=kind==='imap' || kind==='jmap' ? formatMail(source,saved.raw,c) : await readMail(source,id,async()=>saved.raw,c);
     db.query("UPDATE mail SET data=? WHERE source=? AND id=?").run(JSON.stringify(record),source,id);
    }
    const records=(db.query("SELECT data FROM mail WHERE source=? ORDER BY id").all(source) as {data:string}[]).map(row=>JSON.parse(row.data));
    await publish(c,source,records,{mail:source,accountSignature},{...state,projectionVersion:2});
    state=getState(db,source);
   }
   if(state.nextScanAt && Date.now()<state.nextScanAt)continue;
   const backend=connector(c,source);
   if(backend){await syncNativeMail(c,db,source,backend);continue;}
   if(sourceKind(source,c)==='gmail' && await syncGmailChanges(c,db,source,execute))continue;
   state=getState(db,source);
   state={...state,accountSignature,cycle:state.cycle||now(),state:state.lastCompleteScan?'refreshing':'backfilling',error:null,syncStrategy:'snapshot-reconciliation'};
   const cacheItems=async(items:any[])=>{
    for(let offset=0;offset<items.length;offset+=4){
     const batch=await Promise.allSettled(items.slice(offset,offset+4).map(async item=>{
      const old=db.query("SELECT summary FROM mail WHERE source=? AND id=?").get(source,item.id) as any;
      if(old?.summary!==item.summary){
       let raw:any;const record=await readMail(source,item.id,execute,c,value=>{raw=value;});
       // Write attachment evidence before committing its cached-record checkpoint.
       await privateJSON(join(c.libraryRoot,"mail-raw",source+"-"+(item.id.length>180?hash(item.id):item.id)+".json"),{source,id:item.id,ref:record.ref,accountSignature,raw});
       db.query("INSERT OR REPLACE INTO mail VALUES(?,?,?,?,?)").run(source,item.id,JSON.stringify(record),item.summary,state.cycle);changed=true;
       state.dirty=true;
       if(sourceKind(source,c)==='gmail' && !state.gmailAnchor)state.gmailAnchor=await gmailAnchor(c,source,item.id);
      }else db.query("UPDATE mail SET seen=? WHERE source=? AND id=?").run(state.cycle,source,item.id);
     }));
     const failed=batch.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
    }
   };
   const summaries=(items:any[])=>items.map(item=>({id:item.ref.id,summary:hash(JSON.stringify([item.title,item.author,item.occurredAt,item.metadata]))}));
   // Keep new arrivals visible while historical pages are still backfilling.
   const recent=summaries((await searchMail({source,query:"",limit:25,excludeSpamTrash:true},execute,{remaining:0,records:new Map()},c)).items);
   await cacheItems(recent);
   if(sourceKind(source,c)==='gmail' && !state.gmailAnchor && recent[0])state.gmailAnchor=await gmailAnchor(c,source,recent[0].id);
   let pending:any[]=state.pending||[],next=state.cursor;
   // A complete paginated listing is the deletion reconciliation boundary. Interrupted/failed passes never prune.
   for(let page=0;page<8;page++){
    if(!pending.length){
     const q={source,query:"",limit:25,excludeSpamTrash:true,...(next?{cursor:next}:{})} as Query;
     const result=await searchMail(q,execute,{remaining:0,records:new Map()},c);
     if(result.status!=="ok" || result.scan?.exhausted===false && !result.nextCursor)throw Error("Incomplete mail scan; retaining cached records");
     pending=summaries(result.items);next=result.nextCursor;state.pageEnd=!next;
    }
    state={...state,pending,cursor:next};setState(db,source,state);
    while(pending.length){
     const batch=pending.slice(0,4);await cacheItems(batch);pending.splice(0,batch.length);
     state={...state,pending,cursor:next};setState(db,source,state);
    }
    if(state.pageEnd){
     const removed=db.query("SELECT id FROM mail WHERE source=? AND seen!=?").all(source,state.cycle) as any[];
     db.query("DELETE FROM mail WHERE source=? AND seen!=?").run(source,state.cycle);
     for(const row of removed)await rm(join(c.libraryRoot,"mail-raw",source+"-"+(row.id.length>180?hash(row.id):row.id)+".json"),{force:true});
     changed ||= removed.length>0;state.dirty ||= removed.length>0;
     state={...state,cycle:null,cursor:undefined,pending:[],pageEnd:false,lastCompleteScan:now(),lastSuccessfulSync:now(),gmailHistory:state.gmailAnchor,gmailPage:undefined,gmailAnchor:undefined,nextScanAt:Date.now()+(state.gmailAnchor?60000:15*60*1000),state:"ready"};break;
    }
   }
   const records=(db.query("SELECT data FROM mail WHERE source=? ORDER BY id").all(source) as any[]).map(r=>JSON.parse(r.data));
   setState(db,source,{...state,checkedAt:now(),records:records.length,coverage:"Cached mailbox text excluding spam/trash; deletion reconciliation only after complete provider scan"});
   if(changed || state.dirty || !state.publishedAt){await publish(c,source,records,{mail:source,accountSignature},{...getState(db,source)});setState(db,source,{...getState(db,source),dirty:false});}
  }catch(e){
   // Fastmail invalidates offsets if mailbox changes. Re-enumerate; keep cached records until a complete pass succeeds.
   const code=errorData(e).code;
   setState(db,source,{...state,...(["STALE_CURSOR","MAIL_COMMAND_FAILED"].includes(code)?{cursor:undefined,pending:[],cycle:null}:{}),state:"error",error:errorData(e),checkedAt:now()});
  }
 }}finally{db.close();}
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
export async function syncLibrary(c:Config){
 requireMaintenance(c);
 if(!c.libraryEnabled || !sourceEnabled(c,"library"))return;
 await markManagedCache(c.libraryRoot);await privateDirectory(c.libraryRoot);await privateDirectory(join(c.libraryRoot,"mail-raw"));
 const db=libraryDB(c,true);for(const source of configuredSourceIds(c).filter(s=>sourceEnabled(c,s) && isProjected(s,c)))if(!getState(db,source).state)setState(db,source,{state:"queued",records:0,chunks:0});db.close();
 // Independent source failures are recorded without starving healthy sources.
 for(const [name,work] of [["native",native],["archives",archives],["mail",syncMail],["documents",documents]] as const){
  try{await work(c);const d=libraryDB(c,true);d.query("DELETE FROM states WHERE source=?").run("maintenance-"+name);d.close();}catch(e){const d=libraryDB(c,true);setState(d,"maintenance-"+name,{state:"error",error:errorData(e),checkedAt:now()});d.close();}
 }
}
if(import.meta.main){process.umask(0o077);await syncLibrary(await loadConfig());console.log(JSON.stringify({ok:true,checkedAt:now()}));}
