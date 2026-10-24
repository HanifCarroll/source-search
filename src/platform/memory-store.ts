import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory} from './storage';
import {regular} from './source-files';
import {fail,hash,stableJson,now,cursor,position} from '../domain/identity';
import {changeCursor,changePosition} from '../domain/changes';
import {memoryRevisionSchema,type MemoryRevision,type WriteMemory,type CheckedEvidence,type listMemoriesSchema} from '../domain/memory';
import type {z} from 'zod';

type Row={data:string};
const parse=(row:Row|null)=>row?JSON.parse(row.data) as MemoryRevision:undefined;
const high=(db:Database)=>(db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM revisions').get() as {n:number}).n;
const epoch=(db:Database)=>(db.query('SELECT epoch FROM identity').get() as {epoch:string}).epoch;
const current=(db:Database,id:string)=>parse(db.query('SELECT data FROM revisions WHERE id=? ORDER BY revision DESC LIMIT 1').get(id) as Row|null);
const receipt=(db:Database,operationId:string,requestHash:string)=>{
  const saved=parse(db.query('SELECT data FROM revisions WHERE operation_id=?').get(operationId) as Row|null);
  if(saved&&saved.requestHash!==requestHash)fail('OPERATION_CONFLICT','This operationId was already used with different input');
  return saved;
};
function insert(db:Database,r:MemoryRevision){db.query('INSERT INTO revisions VALUES(?,?,?,?,?,?)').run(r.sequence,r.id,r.revision,r.operationId,r.requestHash,JSON.stringify(r));}

// One transaction owns revision, retry receipt and feed position. No source I/O
// occurs here. Immutable revisions also make paginated reads and exports stable.
export function memoryStore(root:string){
  const path=join(root,'memory.sqlite');
  async function connect(write=false):Promise<Database|undefined>{
    if(write){await privateDirectory(root);try{const file=await open(path,'wx',0o600);await file.close();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
    try{const file=await regular(path);if(file.mode&0o077)fail('UNSAFE_PATH','Memory database must be private (0600)');}
    catch(e){if(!write&&(e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    await privateDirectory(root,false);
    const db=new Database(path,write?{readwrite:true}:{readonly:true});
    try{
      db.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL');
      const version=()=>(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(version()===0&&write)db.transaction(()=>{
        if(version()===1)return;
        if(version()!==0||db.query('SELECT name FROM sqlite_master').all().length)fail('UNSUPPORTED_SCHEMA','Memory path contains an incompatible database');
        db.exec(`CREATE TABLE identity(epoch TEXT NOT NULL);
          CREATE TABLE revisions(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL,revision INTEGER NOT NULL,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(id,revision));
          PRAGMA user_version=1;`);
        db.query('INSERT INTO identity VALUES(?)').run(randomUUID());
      }).immediate();
      else if(version()===0&&!write&&!db.query('SELECT name FROM sqlite_master').all().length){db.close();return;}
      if(version()!==1||!db.query("SELECT name FROM sqlite_master WHERE name='revisions'").get())fail('UNSUPPORTED_SCHEMA','Memory store needs a compatible Source Search version');
      return db;
    }catch(e){db.close();throw e;}
  }
  async function read(id:string,revision?:number){
    const db=await connect();if(!db)return;
    try{return revision?parse(db.query('SELECT data FROM revisions WHERE id=? AND revision=?').get(id,revision) as Row|null):current(db,id);}finally{db.close();}
  }
  async function replay(operationId:string,requestHash:string){const db=await connect();if(!db)return;try{return receipt(db,operationId,requestHash);}finally{db.close();}}
  async function write(request:WriteMemory,evidence:CheckedEvidence[]){
    const requestHash=hash(stableJson(request)),db=(await connect(true))!;
    try{return db.transaction(()=>{
      const previousReceipt=receipt(db,request.operationId,requestHash);if(previousReceipt)return previousReceipt;
      const old=request.id?current(db,request.id):undefined;
      if(request.id&&(!old||old.revision!==request.expectedRevision))fail('REVISION_CONFLICT','Memory changed or is missing; read its current revision before editing');
      if(request.action==='retract'&&old?.status==='retracted')fail('ALREADY_RETRACTED','Memory is already retracted');
      const content=request.memory||old!.content;
      if(content.corrects&&!db.query('SELECT 1 FROM revisions WHERE id=? AND revision=?').get(content.corrects.id,content.corrects.revision))fail('MISSING_MEMORY','Correction target revision does not exist');
      const time=now();
      const saved:MemoryRevision={id:old?.id||randomUUID(),revision:(old?.revision||0)+1,sequence:high(db)+1,operationId:request.operationId,requestHash,status:request.action==='retract'?'retracted':'active',createdAt:old?.createdAt||time,updatedAt:time,reason:request.reason,content,evidence:request.action==='retract'?old!.evidence:evidence};
      insert(db,saved);return saved;
    }).immediate();}finally{db.close();}
  }
  async function list(q:z.infer<typeof listMemoriesSchema>){
    const db=await connect();if(!db){if(q.cursor)fail('FEED_RESET','Memory store is missing; start a new list');return {items:[] as MemoryRevision[]};}
    try{return db.transaction(()=>{
      const {cursor:token,limit,...filters}=q,key=hash(stableJson(filters)+epoch(db)),top=high(db);
      let point={high:top,before:top+1};
      if(token){try{point=JSON.parse(String(position(token,key)));}catch{fail('INVALID_CURSOR','Invalid memory-list cursor');}}
      if(!Number.isSafeInteger(point.high)||point.high<0||point.high>top||!Number.isSafeInteger(point.before)||point.before<1||point.before>point.high+1)fail('INVALID_CURSOR','Invalid memory-list position');
      const rows=db.query(`WITH latest AS (SELECT id,MAX(sequence) AS sequence FROM revisions WHERE sequence<=? GROUP BY id)
        SELECT r.data FROM revisions r JOIN latest l ON r.sequence=l.sequence
        WHERE r.sequence<? AND (? OR json_extract(r.data,'$.status')='active')
        AND (? IS NULL OR json_extract(r.data,'$.content.kind')=?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.data,'$.content.entities') WHERE value=?)) ORDER BY r.sequence DESC`).iterate(point.high,point.before,q.includeRetracted?1:0,q.kind||null,q.kind||null,q.entity||null,q.entity||null) as Iterable<Row>;
      const items:MemoryRevision[]=[];
      for(const row of rows){const r=parse(row)!;if(r.content.text.normalize('NFKC').toLowerCase().includes(q.query.normalize('NFKC').toLowerCase()))items.push(r);if(items.length>limit)break;}
      const more=items.length>limit;items.length=Math.min(items.length,limit);
      return {items,...(more?{nextCursor:cursor(key,JSON.stringify({high:point.high,before:items.at(-1)!.sequence}))}:{})};
    })();}finally{db.close();}
  }
  async function changes(token:string|undefined,limit:number){
    const db=await connect();
    if(!db){changePosition(token,'memory',null,0);return {items:[] as MemoryRevision[],cursor:changeCursor('memory',null,0),hasMore:false};}
    try{return db.transaction(()=>{
      const top=high(db),identity=epoch(db),after=changePosition(token,'memory',identity,top);
      const rows=db.query('SELECT data FROM revisions WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,limit+1) as Row[],hasMore=rows.length>limit;
      const items=rows.slice(0,limit).map(r=>parse(r)!);
      return {items,cursor:changeCursor('memory',identity,hasMore?items.at(-1)!.sequence:top),hasMore};
    })();}finally{db.close();}
  }
  async function exportData(){
    const db=await connect();if(!db)return {format:'source-search-memory' as const,version:1 as const,entries:[] as MemoryRevision[]};
    try{return db.transaction(()=>{
      const bytes=(db.query('SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS n FROM revisions').get() as {n:number}).n;
      if(bytes>60*1024*1024)fail('EXPORT_LIMIT','Memory export exceeds 60 MiB; back up the database using SQLite backup tooling');
      return {format:'source-search-memory' as const,version:1 as const,entries:(db.query('SELECT data FROM revisions ORDER BY sequence').all() as Row[]).map(r=>parse(r)!)};
    })();}finally{db.close();}
  }
  async function restore(entries:MemoryRevision[]){
    const db=(await connect(true))!;
    try{db.transaction(()=>{
      if(high(db))fail('MEMORY_NOT_EMPTY','Restore requires an empty memory store; choose a separate memoryRoot');
      for(const row of entries)insert(db,memoryRevisionSchema.parse(row));
      db.query('UPDATE identity SET epoch=?').run(randomUUID());
    }).immediate();return {restoredRevisions:entries.length};}finally{db.close();}
  }
  return {path,read,replay,write,list,changes,exportData,restore};
}
