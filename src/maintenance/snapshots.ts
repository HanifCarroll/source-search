import {dirname} from 'node:path';
import {lock} from 'proper-lockfile';
import {requireMaintenance,requireSource,sourceScope,type Config} from '../platform/config';
import {privateDirectory,markManagedCache} from '../platform/storage';
import {snapshotStore,type SourceCache} from '../sources/sync/cache';
import type {SourceProvider} from '../sources/sync/model';
import {sourceKind} from '../domain/source-catalog';
import {errorData,fail,now} from '../domain/identity';

// The only writer of provider snapshots. Locks, validation, atomic checkpoints,
// failure retention are identical for every app. Search projections are separate.
export async function syncSnapshots(c:Config,sources:string[],factory:(c:Config,source:string)=>SourceProvider){
  requireMaintenance(c);const results=[];
  for(const source of sources){
    requireSource(c,source);
    let release:(()=>Promise<void>)|undefined,compromised:Error|undefined,previous:SourceCache|undefined;
    const namespace=sourceKind(source,c)==='tasks'?'task-snapshots':'source-snapshots';
    const store=snapshotStore(c,source);
    try{
      await markManagedCache(c.libraryRoot);await privateDirectory(dirname(store.lockPath));
      release=await lock(store.lockPath,{realpath:false,stale:300000,update:10000,retries:0,onCompromised:e=>{compromised=e;}});
      try{previous=await store.migrate();}catch(e){if(errorData(e).code!=='STALE_INDEX')throw e;}
      const snapshot=await factory(c,source).sync(previous?.checkpoint);
      const limit=namespace==='task-snapshots'?20000:100000;
      if(snapshot.records.length>limit)fail('SOURCE_LIMIT',`Source exceeds ${limit.toLocaleString('en-US')} records; select fewer collections`);
      const ids=new Set<string>();
      for(const record of snapshot.records){if(record.ref.source!==source||!record.ref.id||!record.ref.version||ids.has(record.ref.id))fail('INVALID_PROVIDER_RESPONSE','Snapshot contains duplicate or mismatched identities');ids.add(record.ref.id);}
      const saved:SourceCache={...snapshot,version:1,scope:sourceScope(c,source),checkedAt:now()};
      if(Buffer.byteLength(JSON.stringify(saved,null,2))>128*1024*1024)fail('SOURCE_LIMIT','Source snapshot exceeds 128 MiB');
      if(compromised)throw compromised;
      await store.write(saved);
      results.push({source,ok:true,records:saved.records.length,strategy:saved.strategy});
    }catch(e){
      const error=errorData(e);results.push({source,ok:false,error});
      if(release&&!compromised&&previous){try{await store.failure(previous,error,now());}catch{ /* The committed snapshot still survives a failed error-state write. */ }}
    }finally{await release?.();}
  }
  return {ok:results.every(r=>r.ok),sources:results};
}
