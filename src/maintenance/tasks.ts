import {dirname} from 'node:path';
import {lock} from 'proper-lockfile';
import {configuredSourceIds,requireMaintenance,requireSource,sourceEnabled,sourceScope,type Config} from '../platform/config';
import {privateDirectory,markManagedCache} from '../platform/storage';
import {taskProvider,taskCache,taskCachePath,type TaskCache} from '../sources/tasks';
import type {TaskProvider} from '../sources/tasks/model';
import {privateJSON,publish,libraryDB,getState,setState} from '../search/library/store';
import {errorData,fail,now} from '../domain/identity';

export async function syncTasks(c:Config,selected?:string,factory=taskProvider){
  requireMaintenance(c);
  if(selected){requireSource(c,selected);if(c.sources[selected]?.adapter!=='tasks')fail('INVALID_SOURCE','sync-tasks requires a tasks source');}
  const sources=selected?[selected]:configuredSourceIds(c).filter(s=>sourceEnabled(c,s)&&c.sources[s]?.adapter==='tasks');
  const results=[];
  for(const source of sources){
    let release:(()=>Promise<void>)|undefined,compromised:Error|undefined,previous:TaskCache|undefined;
    try{
      const path=taskCachePath(c,source);
      await markManagedCache(c.libraryRoot);await privateDirectory(dirname(path));
      // Serialize explicit CLI syncs and the existing maintenance worker.
      // Heartbeats let a later run recover a lock after a crashed process.
      release=await lock(path,{realpath:false,stale:300000,update:10000,retries:0,onCompromised:e=>{compromised=e;}});
      try{previous=await taskCache(c,source);}catch(e){if(errorData(e).code!=='STALE_INDEX')throw e;}
      const provider:TaskProvider=factory(c,source),snapshot=await provider.sync(previous?.checkpoint);
      if(snapshot.records.length>20000)fail('SOURCE_LIMIT','Task source exceeds 20,000 records');
      const ids=new Set<string>();
      for(const record of snapshot.records){if(record.ref.source!==source||ids.has(record.ref.id))fail('INVALID_PROVIDER_RESPONSE','Task snapshot contains duplicate or mismatched identities');ids.add(record.ref.id);}
      const saved:TaskCache={...snapshot,version:1,scope:sourceScope(c,source),checkedAt:now()};
      if(Buffer.byteLength(JSON.stringify(saved,null,2))>32*1024*1024)fail('SOURCE_LIMIT','Task snapshot exceeds 32 MiB');
      // Advance records and the provider checkpoint together. A failed provider
      // pass never removes cached tasks or commits its partial checkpoint.
      if(compromised)throw compromised;
      await privateJSON(path,saved);
      if(c.libraryEnabled&&sourceEnabled(c,'library'))await publish(c,source,saved.records,{tasks:source},{state:'ready',error:null,checkedAt:saved.checkedAt,lastSuccessfulSync:saved.checkedAt,syncStrategy:saved.strategy,coverage:saved.coverage});
      results.push({source,ok:true,records:saved.records.length,strategy:saved.strategy});
    }catch(e){
      const error=errorData(e);results.push({source,ok:false,error});
      if(release&&!compromised&&previous)await privateJSON(taskCachePath(c,source),{...previous,lastError:error,lastAttemptAt:now()});
      if(error.code!=='ELOCKED'&&c.libraryEnabled&&sourceEnabled(c,'library')){await privateDirectory(c.libraryRoot);const db=libraryDB(c,true);try{setState(db,source,{...getState(db,source),state:'error',error,checkedAt:now()});}finally{db.close();}}
    }finally{await release?.();}
  }
  return {ok:results.every(r=>r.ok),sources:results};
}
