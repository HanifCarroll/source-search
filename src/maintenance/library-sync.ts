import {getMailState,setMailState} from '../platform/cache-state';
import {syncSources,snapshotSources} from './sources';
import {snapshotStore} from '../sources/sync/cache';
import {publishDirect} from './direct-publication';
import {syncMail as syncMailbox} from './mail';
import {withSourceLock} from './source-lock';
import {isMail} from '../domain/source-catalog';
import { isProjected } from "../domain/source-policy";
import {privateDirectory,privateJSON,markManagedCache} from "../platform/storage";
/** Explicit maintenance entry point. Never imported by the read-only MCP gateway. */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { loadConfig, sourceEnabled, requireMaintenance, configuredSourceIds, mailAccount, sourceScope, type Config } from "../platform/config";
import { run, type Run, type MailSource } from "../sources/mail/index";
import { now, errorData, fail } from "../domain/identity";
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
  try{
   await withSourceLock(c,'mail-'+source,async()=>{const db=libraryDB(c,true);try{await publishCachedMail(c,db,source);}finally{db.close();}});
  }catch(e){
   // The source worker is still committing this mailbox. Leave its checkpoint
   // and prior projection alone; publish the other mailboxes and retry later.
   if(errorData(e).code==='ELOCKED')continue;
   const db=libraryDB(c,true);
   try{setState(db,source,{...getState(db,source),state:'error',error:errorData(e),checkedAt:now()});}finally{db.close();}
  }
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
 for(const [name,work] of [["direct",publishDirect],["snapshots",publishSnapshots],["mail",publishMail],["documents",documents]] as const){
  try{await work(c);const d=libraryDB(c,true);d.query("DELETE FROM states WHERE source=?").run("maintenance-"+name);d.close();}catch(e){const d=libraryDB(c,true);setState(d,"maintenance-"+name,{state:"error",error:errorData(e),checkedAt:now()});d.close();}
 }
 const cleaned=libraryDB(c,true);try{cleaned.query("DELETE FROM states WHERE source IN ('maintenance-tasks','maintenance-connected','maintenance-native','maintenance-archives')").run();}finally{cleaned.close();}
}
if(import.meta.main){process.umask(0o077);await syncLibrary(await loadConfig());console.log(JSON.stringify({ok:true,checkedAt:now()}));}
