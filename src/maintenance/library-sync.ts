import { librarySources } from "../domain/source-policy";
import {privateDirectory,markManagedCache} from "../platform/storage";
/** Explicit maintenance entry point. Never imported by the read-only MCP gateway. */
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig, sourceEnabled, requireMaintenance, type Config } from "../platform/config";
import { allDatabaseRecords, databaseProjectionVersion } from "../sources/local/databases";
import { allMessageRecords } from "../sources/messages/index";
import { archiveSources, exportPaths, archiveSignature, exportProjectionVersion } from "../sources/archives/originals";
import { rebuildArchive } from "../sources/archives/index";
import { readMail, searchMail, run, type Run, type MailSource } from "../sources/mail/index";
import { hash, now, errorData } from "../domain/identity";
import { type Query } from "../domain/contracts";
import { libraryDB, getState, setState, publish, privateJSON } from "../search/library/store";

export async function stampPaths(paths:string[]){const values=[];for(const p of paths){try{const s=await lstat(p);values.push([p,s.size,s.mtimeMs,s.ctimeMs,s.ino]);}catch(e){if((e as any).code!=="ENOENT")throw e;values.push([p,null]);}}return hash(JSON.stringify(values));}
async function native(c:Config){
 const db=libraryDB(c,true);
 try{
  for(const source of ["calls","messages","whatsapp"] as const){
   try{
    if(!sourceEnabled(c,source))continue;
    const path=source==="calls"?c.muesli:source==="messages"?c.messages:c.whatsapp,paths=[path,path+"-wal"],signature=await stampPaths(paths);
    const projectionVersion=source==="messages" ? 1 : databaseProjectionVersion(source);
    if(getState(db,source).signature===signature && (getState(db,source).projectionVersion||1)===projectionVersion && getState(db,source).state!=="error")continue;
    const records=source==="messages"?await allMessageRecords(c):await allDatabaseRecords(c,source);
    if(signature!==await stampPaths(paths))throw Error("Source changed during snapshot; retaining previous projection and retrying");
    await publish(c,source,records,{paths,signature},{signature,projectionVersion,state:"ready",error:null,checkedAt:now(),coverage:"Current local database; absent text and phone-only history cannot be recovered"});
   }catch(e){setState(db,source,{...getState(db,source),state:"error",error:errorData(e),checkedAt:now()});}
  }
 }finally{db.close();}
}
async function archives(c:Config){
 let index:Database|undefined;const db=libraryDB(c,true);
 try{
  let rebuild=false;
  try{index=new Database(c.index,{readonly:true});for(const source of archiveSources.filter(s=>sourceEnabled(c,s) && exportPaths(c,s).length)){const r=index.query("SELECT value FROM meta WHERE key=?").get(source) as any;const state=r?JSON.parse(r.value):{};if(state.signature!==await archiveSignature(c,source)||state.projectionVersion!==exportProjectionVersion(source))rebuild=true;}}catch{rebuild=true;}finally{index?.close();index=undefined;}
  if(rebuild)await rebuildArchive(c);
  index=new Database(c.index,{readonly:true});
  for(const source of archiveSources){
    if(!sourceEnabled(c,source))continue;
   if(!exportPaths(c,source).length){setState(db,source,{state:"waiting-for-export",records:0,chunks:0});continue;}
   try{
    const row=index.query("SELECT value FROM meta WHERE key=?").get(source) as any;const state=JSON.parse(row.value);
    if(getState(db,source).signature===state.signature && getState(db,source).projectionFormat===2 && getState(db,source).state!=="error")continue;
    const records=(index.query("SELECT data,body FROM records WHERE source=? ORDER BY id").all(source) as any[]).map(r=>({...JSON.parse(r.data),body:r.body}));
    await publish(c,source,records,{archive:source,signature:state.signature},{projectionFormat:2,signature:state.signature,state:"ready",error:null,checkedAt:now(),coverage:"Selected export snapshot only; no automatic account export"});
   }catch(e){setState(db,source,{...getState(db,source),state:"error",error:errorData(e),checkedAt:now()});}
  }
 }finally{index?.close();db.close();}
}
function command(c:Config):Run{return argv=>run([argv[0]!.endsWith("/.local/bin/gog")?c.gmailBinary:argv[0]!,...argv.slice(1)]);}
export async function syncMail(c:Config,execute:Run=command(c),sources:readonly (MailSource)[]=["mail-personal","mail-consulting","mail-fastmail"]){
 requireMaintenance(c);
 const db=libraryDB(c,true);
 try{for(const source of sources){
  if(!sourceEnabled(c,source))continue;
  let state=getState(db,source),changed=false;
  const accountSignature=hash(JSON.stringify(c.mailAccounts[source]));
  if(state.accountSignature && state.accountSignature!==accountSignature)throw Error("Mail account changed; purge caches before using a different account in this slot");
  try{
   if(state.nextScanAt && Date.now()<state.nextScanAt)continue;
   state={...state,accountSignature,cycle:state.cycle||now(),state:"backfilling",error:null};
   const cacheItems=async(items:any[])=>{
    for(let offset=0;offset<items.length;offset+=4){
     const batch=await Promise.allSettled(items.slice(offset,offset+4).map(async item=>{
      const old=db.query("SELECT summary FROM mail WHERE source=? AND id=?").get(source,item.id) as any;
      if(old?.summary!==item.summary){
       let raw:any;const record=await readMail(source,item.id,async argv=>{raw=await execute(argv);return raw;},c);
       // Write attachment evidence before committing its cached-record checkpoint.
       await privateJSON(join(c.libraryRoot,"mail-raw",source+"-"+item.id+".json"),{source,id:item.id,ref:record.ref,accountSignature,raw});
       db.query("INSERT OR REPLACE INTO mail VALUES(?,?,?,?,?)").run(source,item.id,JSON.stringify(record),item.summary,state.cycle);changed=true;
      }else db.query("UPDATE mail SET seen=? WHERE source=? AND id=?").run(state.cycle,source,item.id);
     }));
     const failed=batch.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
    }
   };
   const summaries=(items:any[])=>items.map(item=>({id:item.ref.id,summary:hash(JSON.stringify([item.title,item.author,item.occurredAt,item.metadata]))}));
   // Keep new arrivals visible while historical pages are still backfilling.
   await cacheItems(summaries((await searchMail({source,query:"",limit:25,excludeSpamTrash:true},execute,{remaining:0,records:new Map()},c)).items));
   let pending:any[]=state.pending||[],next=state.cursor;
   // A complete paginated listing is the deletion reconciliation boundary. Interrupted/failed passes never prune.
   for(let page=0;page<8;page++){
    if(!pending.length){
     const q={source,query:"",limit:25,excludeSpamTrash:true,...(next?{cursor:next}:{})} as Query;
     const result=await searchMail(q,execute,{remaining:0,records:new Map()},c);
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
     for(const row of removed)await rm(join(c.libraryRoot,"mail-raw",source+"-"+row.id+".json"),{force:true});
     changed ||= removed.length>0;
     state={...state,cycle:null,cursor:undefined,pending:[],pageEnd:false,lastCompleteScan:now(),nextScanAt:Date.now()+15*60*1000,state:"ready"};break;
    }
   }
   const records=(db.query("SELECT data FROM mail WHERE source=? ORDER BY id").all(source) as any[]).map(r=>JSON.parse(r.data));
   setState(db,source,{...state,checkedAt:now(),records:records.length,coverage:"Cached mailbox text excluding spam/trash; deletion reconciliation only after complete provider scan"});
   if(changed || !state.publishedAt)await publish(c,source,records,{mail:source,accountSignature},{...getState(db,source)});
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
 await privateJSON(temporaryConfig,c);
 try{
  const child=Bun.spawn([c.extractorPython,join(import.meta.dir,"../../scripts/extract-documents.py"),"--config",temporaryConfig],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});
  if(await child.exited)throw Error("Document extraction failed; see private maintenance log");
 }finally{await rm(temporaryConfig,{force:true});}
 const inventory=JSON.parse(await readFile(join(c.libraryRoot,"documents.json"),"utf8"));
 await publish(c,"documents",inventory.records,{documents:true},{state:inventory.pending?"backfilling":inventory.failures.length?"partial":"ready",pending:inventory.pending,discovered:inventory.discovered,failures:inventory.failures,skipped:inventory.skipped,checkedAt:now(),coverage:"Configured local roots, cached mail and selected Takeout attachments; document text, OCR and local transcription; skipped inputs include PDFs over the page budget and files with no detected text or audio"});
}
export async function syncLibrary(c:Config){
 requireMaintenance(c);
 if(!c.libraryEnabled || !sourceEnabled(c,"library"))return;
 await markManagedCache(c.libraryRoot);await privateDirectory(c.libraryRoot);await privateDirectory(join(c.libraryRoot,"mail-raw"));
 const db=libraryDB(c,true);for(const source of librarySources.filter(s=>sourceEnabled(c,s)))if(!getState(db,source).state)setState(db,source,{state:"queued",records:0,chunks:0});db.close();
 // Independent source failures are recorded without starving healthy sources.
 for(const [name,work] of [["native",native],["archives",archives],["mail",syncMail],["documents",documents]] as const){
  try{await work(c);const d=libraryDB(c,true);d.query("DELETE FROM states WHERE source=?").run("maintenance-"+name);d.close();}catch(e){const d=libraryDB(c,true);setState(d,"maintenance-"+name,{state:"error",error:errorData(e),checkedAt:now()});d.close();}
 }
}
if(import.meta.main){process.umask(0o077);await syncLibrary(await loadConfig());console.log(JSON.stringify({ok:true,checkedAt:now()}));}
