import {Database} from 'bun:sqlite';
import {open,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {RecordData} from '../domain/contracts';
import type {SourceCache} from '../domain/snapshots';
import {fail,hash,stableJson} from '../domain/identity';
import {privateDirectory} from './storage';
import {regular} from './source-files';
import {randomUUID} from 'node:crypto';
import {changeCursor,changePosition} from '../domain/changes';
import {snapshotCoverage} from '../domain/snapshots';
import type {Observation,ObservationState} from '../domain/observations';
import type {Ref} from '../domain/contracts';

const schema=3;
type StateRow={scope:string;data:string};
type Change={sequence:number;source:string;kind:'reset'|'added'|'updated'|'removed';observedAt:string;ref?:Ref;reason?:string};
function initChanges(db:Database){
  db.exec(`CREATE TABLE change_identity(epoch TEXT NOT NULL);
    CREATE TABLE changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX changes_source ON changes(source,scope,sequence);`);
  db.query('INSERT INTO change_identity VALUES(?)').run(randomUUID());
  for(const row of db.query('SELECT source,scope,data FROM snapshots').all() as (StateRow&{source:string})[]){
    const state=JSON.parse(row.data) as SourceCache;
    addChange(db,row.source,row.scope,{kind:'reset',observedAt:state.checkedAt,reason:'Change tracking started; enumerate the current snapshot'});
  }
  db.exec('PRAGMA user_version=2');
}
function initObservations(db:Database){
  db.exec(`CREATE TABLE observations(source TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,id));
    CREATE TABLE observation_states(source TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL);
    PRAGMA user_version=3;`);
}
function addChange(db:Database,source:string,scope:string,event:Omit<Change,'sequence'|'source'>){db.query('INSERT INTO changes(source,scope,data) VALUES(?,?,?)').run(source,scope,JSON.stringify(event));}

// Storage owns atomic records/checkpoints, not provider or search semantics.
// Connections are short-lived; a read transaction sees one complete snapshot.
export function recordStore(path:string){
  async function connect(write=false):Promise<Database|undefined>{
    if(write){
      await privateDirectory(dirname(path));
      try{const file=await open(path,'wx',0o600);await file.close();}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    }
    try{await regular(path);}catch(e){if(!write&&(e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    if(((await lstat(path)).mode&0o077)!==0)fail('UNSAFE_PATH','Record store must be a private file (0600)');
    const db=new Database(path,write?{readwrite:true}:{readonly:true});
    try{
      db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
      const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(version===0&&write){
        db.transaction(()=>{
          // Another process may have initialized the store while we acquired
          // the writer lock. Never adopt an unrelated existing database.
          const current=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
          if(current===schema)return;
          if(current!==0||db.query('SELECT name FROM sqlite_master').all().length)fail('UNSUPPORTED_SCHEMA','Record store path contains an incompatible database');
          db.exec(`CREATE TABLE snapshots(source TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE records(source TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,signature TEXT NOT NULL,data TEXT NOT NULL,
              PRIMARY KEY(source,id),FOREIGN KEY(source) REFERENCES snapshots(source) ON DELETE CASCADE);
            CREATE INDEX records_order ON records(source,ordinal);
            PRAGMA user_version=1;`);
          initChanges(db);initObservations(db);
        }).immediate();
      }else if(version===0&&!write&&!db.query('SELECT name FROM sqlite_master').all().length){
        // No committed snapshot yet, including an interrupted first creation.
        db.close();return;
      }else if((version===1||version===2)&&write){
        db.transaction(()=>{const v=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;if(v===1)initChanges(db);if(v<3)initObservations(db);}).immediate();
      }else if(version!==schema&&version!==1&&version!==2)fail('UNSUPPORTED_SCHEMA','Record store needs a compatible Source Search version');
      return db;
    }catch(e){db.close();throw e;}
  }
  async function read(source:string,scope:string):Promise<SourceCache|undefined>{
    const db=await connect();if(!db)return;
    try{return db.transaction(()=>{
      const row=db.query('SELECT scope,data FROM snapshots WHERE source=?').get(source) as StateRow|null;
      if(!row)return;
      if(row.scope!==scope)fail('STALE_INDEX','Connection changed; run sync-sources to refresh it');
      const records=(db.query('SELECT data FROM records WHERE source=? ORDER BY ordinal').all(source) as {data:string}[]).map(r=>JSON.parse(r.data) as RecordData);
      return {...JSON.parse(row.data),records} as SourceCache;
    })();}finally{db.close();}
  }
  async function write(source:string,saved:SourceCache){
    const {records,...state}=saved,ids=new Set<string>();
    const rows=records.map((r,ordinal)=>{
      if(r.ref.source!==source||!r.ref.id||!r.ref.version||ids.has(r.ref.id))fail('INVALID_PROVIDER_RESPONSE','Snapshot contains duplicate or mismatched identities');
      ids.add(r.ref.id);
      return {id:r.ref.id,ref:r.ref,ordinal,signature:hash(stableJson({...r,observedAt:undefined})),data:JSON.stringify(r)};
    });
    const db=(await connect(true))!;
    try{db.transaction(()=>{
      const old=db.query('SELECT scope FROM snapshots WHERE source=?').get(source) as {scope:string}|null;
      const reset=!old||old.scope!==saved.scope;
      // A new selection/account replaces the old scope only on a successful write.
      if(old&&old.scope!==saved.scope)db.query('DELETE FROM snapshots WHERE source=?').run(source);
      db.query('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET scope=excluded.scope,data=excluded.data').run(source,saved.scope,JSON.stringify(state));
      const previous=new Map((db.query("SELECT id,signature,json_extract(data,'$.ref') AS ref FROM records WHERE source=?").all(source) as {id:string;signature:string;ref:string}[]).map(r=>[r.id,r]));
      const remaining=new Set(previous.keys());
      if(reset)addChange(db,source,saved.scope,{kind:'reset',observedAt:saved.checkedAt,reason:old?'Source selection changed; enumerate the new snapshot':'Initial snapshot; enumerate current records'});
      const upsert=db.query(`INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET
        ordinal=excluded.ordinal,signature=excluded.signature,data=excluded.data
        WHERE records.signature<>excluded.signature OR records.ordinal<>excluded.ordinal`);
      for(const r of rows){
        if(!reset&&previous.get(r.id)?.signature!==r.signature)addChange(db,source,saved.scope,{kind:previous.has(r.id)?'updated':'added',observedAt:saved.checkedAt,ref:r.ref});
        upsert.run(source,r.id,r.ordinal,r.signature,r.data);remaining.delete(r.id);
      }
      const remove=db.query('DELETE FROM records WHERE source=? AND id=?');
      for(const id of remaining){addChange(db,source,saved.scope,{kind:'removed',observedAt:saved.checkedAt,ref:JSON.parse(previous.get(id)!.ref)});remove.run(source,id);}
    }).immediate();}finally{db.close();}
  }
  async function failure(source:string,scope:string,error:{code:string;message:string},attemptedAt:string){
    const db=await connect(true);if(!db)return;
    try{db.transaction(()=>{
      const row=db.query('SELECT scope,data FROM snapshots WHERE source=?').get(source) as StateRow|null;
      if(!row||row.scope!==scope)return;
      db.query('UPDATE snapshots SET data=? WHERE source=?').run(JSON.stringify({...JSON.parse(row.data),lastError:error,lastAttemptAt:attemptedAt}),source);
    }).immediate();}finally{db.close();}
  }
  async function observation(source:string,scope:string){
    const db=await connect();if(!db)return;
    try{return db.transaction(()=>{
      if((db.query('PRAGMA user_version').get() as {user_version:number}).user_version<3)return;
      const row=db.query('SELECT scope,data FROM observation_states WHERE source=?').get(source) as StateRow|null;
      if(!row||row.scope!==scope)return;
      return {state:JSON.parse(row.data) as ObservationState,entries:(db.query('SELECT data FROM observations WHERE source=?').all(source) as {data:string}[]).map(r=>JSON.parse(r.data) as Observation)};
    })();}finally{db.close();}
  }
  // undefined entries is a confirmed unchanged scan. A failed/partial reader
  // never calls this operation, so it cannot prune the last complete inventory.
  async function observe(source:string,scope:string,entries:Observation[]|undefined,state:ObservationState){
    const ids=new Set<string>();
    for(const e of entries||[]){if(e.ref.source!==source||!e.ref.id||!e.ref.version||!e.signature||ids.has(e.ref.id))fail('INVALID_PROVIDER_RESPONSE','Observation contains duplicate or mismatched identities');ids.add(e.ref.id);}
    const db=(await connect(true))!;
    try{return db.transaction(()=>{
      const old=db.query('SELECT scope,data FROM observation_states WHERE source=?').get(source) as StateRow|null;
      const previous=old&&old.scope===scope?JSON.parse(old.data) as ObservationState:undefined;
      const reset=!previous?.initialized||previous.generation!==state.generation;
      if(entries===undefined&&reset)fail('INCOMPLETE_SCAN','A new observation baseline needs a complete inventory');
      let added=0,updated=0,removed=0;
      if(reset){db.query('DELETE FROM observations WHERE source=?').run(source);addChange(db,source,scope,{kind:'reset',observedAt:state.checkedAt,reason:previous?.initialized?'Observed window or index changed; search the current source again':'Change tracking started; search the current source to establish a baseline'});}
      if(entries){
        const prior=new Map((db.query('SELECT id,data FROM observations WHERE source=?').all(source) as {id:string;data:string}[]).map(r=>[r.id,JSON.parse(r.data) as Observation]));
        const upsert=db.query('INSERT INTO observations VALUES(?,?,?) ON CONFLICT(source,id) DO UPDATE SET data=excluded.data WHERE observations.data<>excluded.data');
        for(const e of entries){const before=prior.get(e.ref.id);prior.delete(e.ref.id);
          if(!reset&&before?.signature!==e.signature){const kind=before?'updated':'added';if(before)updated++;else added++;addChange(db,source,scope,{kind,observedAt:state.checkedAt,ref:e.ref});}
          upsert.run(source,e.ref.id,JSON.stringify(e));
        }
        for(const [id,e] of prior){removed++;db.query('DELETE FROM observations WHERE source=? AND id=?').run(source,id);addChange(db,source,scope,{kind:'removed',observedAt:state.checkedAt,ref:e.ref});}
      }
      const records=entries?.length??previous!.records;
      db.query('INSERT INTO observation_states VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET scope=excluded.scope,data=excluded.data').run(source,scope,JSON.stringify({...state,initialized:true,records}));
      return {reset,added,updated,removed,records};
    }).immediate();}finally{db.close();}
  }
  async function observationFailure(source:string,scope:string,error:{code:string;message:string},attemptedAt:string){
    const db=(await connect(true))!;
    try{db.transaction(()=>{
      const row=db.query('SELECT scope,data FROM observation_states WHERE source=?').get(source) as StateRow|null;
      const state=row&&row.scope===scope?JSON.parse(row.data):{initialized:false};
      db.query('INSERT INTO observation_states VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET scope=excluded.scope,data=excluded.data').run(source,scope,JSON.stringify({...state,lastError:error,lastAttemptAt:attemptedAt}));
    }).immediate();}finally{db.close();}
  }
  async function changes(selection:Record<string,string>,token:string|undefined,limit:number){
    const key=hash(stableJson(selection)),db=await connect();
    const empty=()=>{changePosition(token,key,null,0);return {streamId:null,items:[] as Change[],cursor:changeCursor(key,null,0),hasMore:false,coverage:Object.keys(selection).map(source=>({source,state:'needs-sync'}))};};
    if(!db)return empty();
    try{return db.transaction(()=>{
      if((db.query('PRAGMA user_version').get() as {user_version:number}).user_version===1)return empty();
      const identity=(db.query('SELECT epoch FROM change_identity').get() as {epoch:string}).epoch;
      const high=(db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM changes').get() as {n:number}).n;
      const after=changePosition(token,key,identity,high),entries=Object.entries(selection);
      const rows=entries.length?db.query(`SELECT sequence,source,data FROM changes WHERE sequence>? AND (${entries.map(()=>'(source=? AND scope=?)').join(' OR ')}) ORDER BY sequence LIMIT ?`).all(after,...entries.flat(),limit+1) as {sequence:number;source:string;data:string}[]:[];
      const hasMore=rows.length>limit,items=rows.slice(0,limit).map(r=>({...JSON.parse(r.data),sequence:r.sequence,source:r.source} as Change));
      const coverage=entries.map(([source,scope])=>{
        const row=db.query('SELECT scope,data FROM snapshots WHERE source=?').get(source) as StateRow|null;
        if(row&&row.scope===scope)return {source,state:'tracked',coverage:snapshotCoverage(JSON.parse(row.data))};
        const observation=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version>=3?db.query('SELECT scope,data FROM observation_states WHERE source=?').get(source) as StateRow|null:null;
        if(observation&&observation.scope===scope){
          const {initialized,signature,generation,records,projection,...coverage}=JSON.parse(observation.data) as ObservationState;
          return {source,state:initialized?'tracked':'needs-sync',...coverage,...(coverage.granularity==='index'?{}:{records})};
        }
        return {source,state:'needs-sync'};
      });
      return {streamId:identity,items,cursor:changeCursor(key,identity,hasMore?items.at(-1)!.sequence:high),hasMore,coverage};
    })();}finally{db.close();}
  }
  return {path,read,write,failure,changes,observation,observe,observationFailure};
}
