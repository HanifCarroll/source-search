import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {z} from 'zod';
import type {RecordData} from '../domain/contracts';
import type {ObservedProjection} from '../domain/observations';
import {sourceDefinition,sourceKind} from '../domain/source-catalog';
import {errorData,fail,now} from '../domain/identity';
import {configuredSourceIds,evidenceScope,requireMaintenance,sourceEnabled,sourceScope,type Config} from '../platform/config';
import {recordStore} from '../platform/record-store';
import {libraryDB,getState,setState,publish} from '../search/library/store';
import {archiveConfig} from './archives';
import {withSourceLock} from './source-lock';

const archiveState=z.object({signature:z.string(),projectionVersion:z.number().int()});
function archiveRecords(c:Config,source:string,projection:ObservedProjection):RecordData[]{
  const kind=sourceKind(source,c),scoped=source===kind?c:archiveConfig(c,source);
  const db=new Database(scoped.index,{readonly:true});
  try{return db.transaction(()=>{
    const row=db.query('SELECT value FROM meta WHERE key=?').get(kind) as {value:string}|null;
    const saved=archiveState.parse(row?JSON.parse(row.value):null);
    if(saved.signature!==projection.revision||saved.projectionVersion!==projection.version)
      fail('NEEDS_SYNC','Archive index changed; run sync-sources before publishing it');
    return (db.query('SELECT data,body FROM records WHERE source=? ORDER BY id').all(kind) as {data:string;body:string}[])
      .map(row=>{const record=JSON.parse(row.data) as RecordData;return {...record,body:row.body,...(source!==kind?{adapter:kind}:{}),ref:{...record.ref,source}};});
  })();}finally{db.close();}
}

// Source synchronization owns the inventory, decoding and checkpoint. This
// consumer never opens a source database or reparses an export.
export async function publishDirect(c:Config){
  requireMaintenance(c);
  if(!c.libraryEnabled||!sourceEnabled(c,'library'))return;
  const store=recordStore(join(c.libraryRoot,'records.sqlite'));
  const sources=configuredSourceIds(c).filter(source=>sourceEnabled(c,source)&&['native','archive'].includes(sourceDefinition(source,c)?.tracking||''));
  for(const source of sources){
    try{await withSourceLock(c,'direct-'+source,async()=>{
      const db=libraryDB(c,true);
      try{
        const saved=await store.observation(source,evidenceScope(c,source));
        const projection=saved?.state.projection;
        if(!saved?.state.initialized||!projection||projection.scope!==sourceScope(c,source))
          fail('NEEDS_SYNC','Run sync-sources to prepare this source for library indexing');
        const state=saved.state,previous=getState(db,source);
        const freshness={state:state.lastError?'error':'ready',error:state.lastError||null,
          checkedAt:state.lastAttemptAt||state.checkedAt,lastSuccessfulSync:state.checkedAt,
          syncStrategy:state.strategy,coverage:state.coverage};
        if(previous.consumedRevision===projection.revision&&previous.scope===projection.scope&&previous.projectionVersion===projection.version){
          setState(db,source,{...previous,...freshness,incremental:projection.incremental});
          return;
        }
        const records=projection.kind==='archive'?archiveRecords(c,source,projection):saved.entries.map(entry=>{
          if(!entry.record)fail('NEEDS_SYNC','Run sync-sources to fill the native record cache');
          return entry.record;
        });
        await publish(c,source,records,projection.guard,{...freshness,scope:projection.scope,
          consumedRevision:projection.revision,projectionVersion:projection.version,incremental:projection.incremental});
        // Retire the old duplicate cache only after its replacement is committed
        // and published. Older installs can still rebuild it from originals.
        if(projection.kind==='native'&&db.query("SELECT 1 FROM sqlite_master WHERE name='native_records'").get())
          db.query('DELETE FROM native_records WHERE source=?').run(source);
      }catch(e){setState(db,source,{...getState(db,source),state:'error',error:errorData(e),checkedAt:now()});}
      finally{db.close();}
    });}catch(e){if(errorData(e).code!=='ELOCKED')throw e;}
  }
}
