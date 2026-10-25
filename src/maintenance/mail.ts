import type {Database} from 'bun:sqlite';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory,privateJSON} from '../platform/storage';
import {cacheDB} from '../platform/cache-db';
import {getMailState as getState,setMailState as setState,type MailState} from '../platform/cache-state';
import {configuredSourceIds,requireMaintenance,sourceEnabled,sourceScope,type Config} from '../platform/config';
import {isMail,sourceKind} from '../domain/source-catalog';
import {hash,now,errorData} from '../domain/identity';
import type {Query} from '../domain/contracts';
import {readMail,searchMail,formatMail,connector,run,type Run,type MailSource} from '../sources/mail/index';
import {syncNativeMail,syncGmailChanges,gmailAnchor} from './mail-sync';
import {withSourceLock} from './source-lock';

export async function syncMail(c:Config,execute:Run=run,sources:readonly MailSource[]=configuredSourceIds(c).filter(id=>isMail(id,c)),publishCached?:(c:Config,db:Database,source:string)=>Promise<void>){
 requireMaintenance(c);
 await privateDirectory(c.libraryRoot);await privateDirectory(join(c.libraryRoot,'mail-raw'));
 for(const source of sources){
  if(!sourceEnabled(c,source))continue;
  await withSourceLock(c,"mail-"+source,async()=>{
  const db=cacheDB(c,true);try{
  let state=getState(db,source);
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
    setState(db,source,{...state,projectionVersion:2,dirty:true});
    state=getState(db,source);
   }
   if(state.nextScanAt && Date.now()<state.nextScanAt)return;
   const backend=connector(c,source);
   if(backend){await syncNativeMail(c,db,source,backend);return;}
   if(sourceKind(source,c)==='gmail' && await syncGmailChanges(c,db,source,execute))return;
   state=getState(db,source);
   const cycle=state.cycle||now();
   state={...state,accountSignature,cycle,state:state.lastCompleteScan?'refreshing':'backfilling',error:null,syncStrategy:'snapshot-reconciliation'};
   const cacheItems=async(items:any[])=>{
    for(let offset=0;offset<items.length;offset+=4){
     const batch=await Promise.allSettled(items.slice(offset,offset+4).map(async item=>{
      const old=db.query("SELECT summary FROM mail WHERE source=? AND id=?").get(source,item.id) as any;
      if(old?.summary!==item.summary){
       let raw:any;const record=await readMail(source,item.id,execute,c,value=>{raw=value;});
       // Write attachment evidence before committing its cached-record checkpoint.
       await privateJSON(join(c.libraryRoot,"mail-raw",source+"-"+(item.id.length>180?hash(item.id):item.id)+".json"),{source,id:item.id,ref:record.ref,accountSignature,raw});
       db.query("INSERT OR REPLACE INTO mail VALUES(?,?,?,?,?)").run(source,item.id,JSON.stringify(record),item.summary,cycle);
       state.dirty=true;
       if(sourceKind(source,c)==='gmail' && !state.gmailAnchor)state.gmailAnchor=await gmailAnchor(c,source,item.id);
      }else db.query("UPDATE mail SET seen=? WHERE source=? AND id=?").run(cycle,source,item.id);
     }));
     const failed=batch.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
    }
   };
   const summaries=(items:any[])=>items.map(item=>({id:item.ref.id,summary:hash(JSON.stringify([item.title,item.author,item.occurredAt,item.metadata]))}));
   // Keep new arrivals visible while historical pages are still backfilling.
   const recent=summaries((await searchMail({source,query:"",limit:25,excludeSpamTrash:true},execute,{remaining:0,records:new Map()},c)).items);
   await cacheItems(recent);
   if(sourceKind(source,c)==='gmail' && !state.gmailAnchor && recent[0])state.gmailAnchor=await gmailAnchor(c,source,recent[0].id);
   let pending:NonNullable<MailState['pending']>=state.pending||[],next=state.cursor;
   // A complete paginated listing is the deletion reconciliation boundary. Interrupted/failed passes never prune.
   for(let page=0;page<8;page++){
    if(!pending.length){
     const q={source,query:"",limit:sourceKind(source,c)==='gmail'?100:25,excludeSpamTrash:true,...(next?{cursor:next}:{})} as Query;
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
     const removed=db.query("SELECT id FROM mail WHERE source=? AND seen!=?").all(source,cycle) as any[];
     db.query("DELETE FROM mail WHERE source=? AND seen!=?").run(source,cycle);
     for(const row of removed)await rm(join(c.libraryRoot,"mail-raw",source+"-"+(row.id.length>180?hash(row.id):row.id)+".json"),{force:true});
     state.dirty ||= removed.length>0;
     state={...state,cycle:null,cursor:undefined,pending:[],pageEnd:false,lastCompleteScan:now(),lastSuccessfulSync:now(),gmailHistory:state.gmailAnchor,gmailPage:undefined,gmailAnchor:undefined,nextScanAt:Date.now()+(state.gmailAnchor?60000:15*60*1000),state:"ready"};break;
    }
   }
   const records=(db.query("SELECT count(*) n FROM mail WHERE source=?").get(source) as {n:number}).n;
   setState(db,source,{...state,checkedAt:now(),records,coverage:"Cached mailbox text excluding spam/trash; deletion reconciliation only after complete provider scan"});
  }catch(e){
   // Fastmail invalidates offsets if mailbox changes. Re-enumerate; keep cached records until a complete pass succeeds.
   const code=errorData(e).code;
   setState(db,source,{...state,...(["STALE_CURSOR","MAIL_COMMAND_FAILED"].includes(code)?{cursor:undefined,pending:[],cycle:null}:{}),state:"error",error:errorData(e),checkedAt:now()});
  }
 }finally{try{await publishCached?.(c,db,source);}finally{db.close();}}
  });
 }
}
