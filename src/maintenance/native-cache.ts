import type {Database} from 'bun:sqlite';
import type {RecordData} from '../domain/contracts';
import {hash} from '../domain/identity';

// Native app databases do not promise a durable change log. Compare complete,
// consistent inventories to catch edits and deletions, but decode only new or
// changed rows (including joined captions, contacts and conversation metadata).
export function nativeCache(db:Database,source:string,format:string){
  db.exec('CREATE TABLE IF NOT EXISTS native_records(source TEXT,key TEXT,signature TEXT,data TEXT,PRIMARY KEY(source,key))');
  const old=new Map((db.query('SELECT key,signature,data FROM native_records WHERE source=?').all(source) as {key:string;signature:string;data:string}[]).map(r=>[r.key,r]));
  const updates:{key:string;signature:string;data:string}[]=[];
  let reused=0;
  return {
    reuse(key:string,raw:unknown,project:()=>RecordData){
      const signature=hash(format+JSON.stringify(raw,(_k,v)=>typeof v==='bigint'?String(v):v instanceof Uint8Array?Buffer.from(v).toString('base64'):v)),saved=old.get(key);old.delete(key);
      if(saved?.signature===signature){reused++;return JSON.parse(saved.data) as RecordData;}
      const record=project();updates.push({key,signature,data:JSON.stringify(record)});return record;
    },
    commit(){
      db.transaction(()=>{
        for(const key of old.keys())db.query('DELETE FROM native_records WHERE source=? AND key=?').run(source,key);
        for(const r of updates)db.query('INSERT OR REPLACE INTO native_records VALUES(?,?,?,?)').run(source,r.key,r.signature,r.data);
      })();
      return {decoded:updates.length,reused,removed:old.size};
    },
  };
}
