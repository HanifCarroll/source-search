import {Database} from 'bun:sqlite';
import {open,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {RecordData} from '../domain/contracts';
import type {SourceCache} from '../domain/snapshots';
import {fail,hash,stableJson} from '../domain/identity';
import {privateDirectory} from './storage';
import {regular} from './source-files';

const schema=1;
type StateRow={scope:string;data:string};

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
        }).immediate();
      }else if(version===0&&!write&&!db.query('SELECT name FROM sqlite_master').all().length){
        // No committed snapshot yet, including an interrupted first creation.
        db.close();return;
      }else if(version!==schema)fail('UNSUPPORTED_SCHEMA','Record store needs a compatible Source Search version');
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
      return {id:r.ref.id,ordinal,signature:hash(stableJson({...r,observedAt:undefined})),data:JSON.stringify(r)};
    });
    const db=(await connect(true))!;
    try{db.transaction(()=>{
      const old=db.query('SELECT scope FROM snapshots WHERE source=?').get(source) as {scope:string}|null;
      // A new selection/account replaces the old scope only on a successful write.
      if(old&&old.scope!==saved.scope)db.query('DELETE FROM snapshots WHERE source=?').run(source);
      db.query('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET scope=excluded.scope,data=excluded.data').run(source,saved.scope,JSON.stringify(state));
      const remaining=new Set((db.query('SELECT id FROM records WHERE source=?').all(source) as {id:string}[]).map(r=>r.id));
      const upsert=db.query(`INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET
        ordinal=excluded.ordinal,signature=excluded.signature,data=excluded.data
        WHERE records.signature<>excluded.signature OR records.ordinal<>excluded.ordinal`);
      for(const r of rows){upsert.run(source,r.id,r.ordinal,r.signature,r.data);remaining.delete(r.id);}
      const remove=db.query('DELETE FROM records WHERE source=? AND id=?');
      for(const id of remaining)remove.run(source,id);
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
  return {path,read,write,failure};
}
