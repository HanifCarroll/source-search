import {cacheDB} from '../../platform/cache-db';
import {getMailState as getState} from '../../platform/cache-state';
import {fail,now} from '../../domain/identity';
import {syncMail} from '../mail';
import {state,type Reader} from './model';
import type {Ref} from '../../domain/contracts';

export const mail:Reader=async(c,source)=>{
 await syncMail(c,undefined,[source]);
 const db=cacheDB(c);
 try{return db.transaction(()=>{
  const saved=getState(db,source);
  if(saved.error)fail(saved.error.code||'SYNC_FAILED',saved.error.message||'Mail synchronization failed');
  if(!saved.lastCompleteScan)fail('INITIAL_SYNC_PENDING','Mail is backfilling; the change baseline starts after the first complete mailbox scan');
  const entries=(db.query("SELECT json_extract(data,'$.ref') ref FROM mail WHERE source=? ORDER BY id").all(source) as {ref:string}[]).map(row=>{const ref=JSON.parse(row.ref) as Ref;return {ref,signature:ref.version!};});
  return {entries,state:{...state(saved.syncStrategy||'mail-reconciliation',saved.coverage||'Selected mailbox cache; provider-confirmed removals only'),checkedAt:saved.checkedAt||now(),checkpoint:{lastSuccessfulSync:saved.lastSuccessfulSync,lastCompleteScan:saved.lastCompleteScan,state:saved.state}}};
 })();}finally{db.close();}
};
