import type {Database} from 'bun:sqlite';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {RecordData} from '../domain/contracts';
import type {Config} from '../platform/config';
import {sourceScope,mailAccount} from '../platform/config';
import {errorData,hash,now} from '../domain/identity';
import {formatMail,readMail,type Run} from '../sources/mail/index';
import type {MailConnector} from '../sources/mail/types';
import {getState,setState,privateJSON,publish} from '../search/library/store';

export const rawMailPath=(c:Config,source:string,id:string)=>join(c.libraryRoot,'mail-raw',source+'-'+(id.length>180?hash(id):id)+'.json');
async function publishMail(c:Config,db:Database,source:string,state:any){
  if(state.dirty || !state.publishedAt){
    const records=(db.query('SELECT data FROM mail WHERE source=? ORDER BY id').all(source) as {data:string}[]).map(r=>JSON.parse(r.data));
    await publish(c,source,records,{mail:source,accountSignature:sourceScope(c,source)},state);
    setState(db,source,{...getState(db,source),dirty:false});
  }
}
export async function syncNativeMail(c:Config,db:Database,source:string,backend:MailConnector){
  let state=getState(db,source);
  try{
    for(let page=0;page<8;page++){
      const result=await backend.sync(state.syncCheckpoint),removed=new Set(result.removed);
      if(result.inventory){
        const live=new Set(result.inventory);
        for(const {id} of db.query('SELECT id FROM mail WHERE source=?').all(source) as {id:string}[])if(!live.has(id))removed.add(id);
      }
      const writes:{id:string;record:RecordData;summary:string}[]=[];
      for(const raw of result.messages){
        const record=formatMail(source,raw,c),id=record.ref.id;
        const old=db.query('SELECT data FROM mail WHERE source=? AND id=?').get(source,id) as {data:string}|null;
        if(!old || JSON.parse(old.data).ref.version!==record.ref.version){
          await privateJSON(rawMailPath(c,source,id),{source,id,ref:record.ref,accountSignature:sourceScope(c,source),raw});
          writes.push({id,record,summary:hash(JSON.stringify(raw.summary))});
        }
      }
      const completedAt=now();
      // All bodies and raw evidence precede the committed checkpoint. On an
      // interruption the same page is replayed; publication retries via dirty.
      db.transaction(()=>{
        for(const w of writes)db.query('INSERT OR REPLACE INTO mail VALUES(?,?,?,?,?)').run(source,w.id,JSON.stringify(w.record),w.summary,completedAt);
        let deleted=0;for(const id of removed)deleted+=db.query('DELETE FROM mail WHERE source=? AND id=?').run(source,id).changes;
        state={...state,accountSignature:sourceScope(c,source),syncCheckpoint:result.checkpoint,syncStrategy:result.strategy,dirty:state.dirty||writes.length>0||deleted>0,state:result.hasMore?(state.lastCompleteScan?'refreshing':'backfilling'):'ready',error:null,checkedAt:completedAt,nextScanAt:result.hasMore?0:Date.now()+60000,...(!result.hasMore?{lastCompleteScan:completedAt,lastSuccessfulSync:completedAt}:{}),records:(db.query('SELECT count(*) n FROM mail WHERE source=?').get(source) as {n:number}).n,coverage:'Cached mailbox text excluding spam/trash; provider changes and confirmed removals applied incrementally'};
        setState(db,source,state);
      })();
      for(const id of removed)await rm(rawMailPath(c,source,id),{force:true});
      if(!result.hasMore)break;
    }
    await publishMail(c,db,source,state);
  }catch(e){
    setState(db,source,{...state,...(['STALE_CURSOR','STALE_RECORD','NOT_FOUND'].includes(errorData(e).code)?{syncCheckpoint:undefined}:{}),state:'error',error:errorData(e),checkedAt:now(),nextScanAt:0});
  }
}

// gog 0.16's history command exposes additions only. Keep a daily full
// reconciliation for deletions/labels; do not pretend this is a complete feed.
export async function syncGmailChanges(c:Config,db:Database,source:string,execute:Run):Promise<boolean>{
  let state=getState(db,source);
  if(!state.gmailHistory || !state.lastCompleteScan || state.cursor || state.pending?.length || Date.now()-Date.parse(state.lastCompleteScan)>=86400000)return false;
  try{
    let page=state.gmailPage;
    for(let i=0;i<8;i++){
      const raw=await execute([c.gmailBinary,'gmail','history','--account',mailAccount(c,source)!.account,'--gmail-no-send','--json','--no-input','--since',state.gmailHistory,'--max','100',...(page?['--page',page]:[])]) as any;
      const ids=raw.messages===null?[]:raw.messages;
      if(!/^\d+$/.test(raw.historyId) || !Array.isArray(ids) || ids.some((id:unknown)=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)))return false;
      for(const id of new Set<string>(ids)){
        let response:any;const record=await readMail(source,id,execute,c,r=>{response=r;});
        const excluded=record.metadata?.labels as string[]|undefined;
        if(excluded?.some(l=>l==='SPAM'||l==='TRASH'))continue;
        const old=db.query('SELECT data FROM mail WHERE source=? AND id=?').get(source,id) as {data:string}|null;
        if(old && JSON.parse(old.data).ref.version===record.ref.version)continue;
        await privateJSON(rawMailPath(c,source,id),{source,id,ref:record.ref,accountSignature:sourceScope(c,source),raw:response});
        db.transaction(()=>{db.query('INSERT OR REPLACE INTO mail VALUES(?,?,?,?,?)').run(source,id,JSON.stringify(record),'history',now());state={...state,dirty:true};setState(db,source,state);})();
      }
      page=raw.nextPageToken||undefined;
      state={...state,gmailPage:page,...(!page?{gmailHistory:raw.historyId,lastSuccessfulSync:now()}:{}),syncStrategy:'gmail-additions-with-daily-reconciliation',state:page?'refreshing':'ready',error:null,checkedAt:now(),nextScanAt:page?0:Date.now()+60000};
      setState(db,source,state);if(!page)break;
    }
    await publishMail(c,db,source,state);return true;
  }catch{
    // Expired history, removed messages and older gog versions recover through
    // the normal complete inventory; no error response can prune records.
    state={...state,gmailHistory:undefined,gmailPage:undefined,nextScanAt:0};setState(db,source,state);return false;
  }
}
export async function gmailAnchor(c:Config,source:string,id:string){
  const saved=JSON.parse(await readFile(rawMailPath(c,source,id),'utf8'));
  const value=saved.raw?.message?.historyId;
  return typeof value==='string' && /^\d+$/.test(value)?value:undefined;
}
