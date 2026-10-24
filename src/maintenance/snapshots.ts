import {dirname} from 'node:path';
import {lock} from 'proper-lockfile';
import {requireMaintenance,requireSource,sourceEnabled,sourceScope,type Config} from '../platform/config';
import {privateDirectory,markManagedCache} from '../platform/storage';
import {snapshotStore,type SourceCache} from '../sources/sync/cache';
import type {SourceProvider} from '../sources/sync/model';
import {privateJSON,publish,libraryDB,getState,setState} from '../search/library/store';
import {errorData,fail,now} from '../domain/identity';

// The only writer of provider snapshots. Locks, validation, atomic checkpoints,
// failure retention and changed-record publication are identical for every app.
export async function syncSnapshots(c:Config,sources:string[],factory:(c:Config,source:string)=>SourceProvider,namespace:'task-snapshots'|'source-snapshots'='source-snapshots'){
  requireMaintenance(c);const results=[];
  for(const source of sources){
    requireSource(c,source);
    let release:(()=>Promise<void>)|undefined,compromised:Error|undefined,previous:SourceCache|undefined;
    const store=snapshotStore(c,source,namespace);
    try{
      await markManagedCache(c.libraryRoot);await privateDirectory(dirname(store.path));
      release=await lock(store.path,{realpath:false,stale:300000,update:10000,retries:0,onCompromised:e=>{compromised=e;}});
      try{previous=await store.read();}catch(e){if(errorData(e).code!=='STALE_INDEX')throw e;}
      const snapshot=await factory(c,source).sync(previous?.checkpoint);
      const limit=namespace==='task-snapshots'?20000:100000;
      if(snapshot.records.length>limit)fail('SOURCE_LIMIT',`Source exceeds ${limit.toLocaleString('en-US')} records; select fewer collections`);
      const ids=new Set<string>();
      for(const record of snapshot.records){if(record.ref.source!==source||!record.ref.id||!record.ref.version||ids.has(record.ref.id))fail('INVALID_PROVIDER_RESPONSE','Snapshot contains duplicate or mismatched identities');ids.add(record.ref.id);}
      const saved:SourceCache={...snapshot,version:1,scope:sourceScope(c,source),checkedAt:now()};
      if(Buffer.byteLength(JSON.stringify(saved,null,2))>128*1024*1024)fail('SOURCE_LIMIT','Source snapshot exceeds 128 MiB');
      if(compromised)throw compromised;
      await privateJSON(store.path,saved);
      if(c.libraryEnabled&&sourceEnabled(c,'library'))await publish(c,source,saved.records,{snapshot:source},{state:'ready',error:null,checkedAt:saved.checkedAt,lastSuccessfulSync:saved.checkedAt,syncStrategy:saved.strategy,coverage:saved.coverage});
      results.push({source,ok:true,records:saved.records.length,strategy:saved.strategy});
    }catch(e){
      const error=errorData(e);results.push({source,ok:false,error});
      if(release&&!compromised&&previous)await privateJSON(store.path,{...previous,lastError:error,lastAttemptAt:now()});
      if(error.code!=='ELOCKED'&&c.libraryEnabled&&sourceEnabled(c,'library')){await privateDirectory(c.libraryRoot);const db=libraryDB(c,true);try{setState(db,source,{...getState(db,source),state:'error',error,checkedAt:now()});}finally{db.close();}}
    }finally{await release?.();}
  }
  return {ok:results.every(r=>r.ok),sources:results};
}
