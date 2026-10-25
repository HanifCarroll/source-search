import {Database} from 'bun:sqlite';
import {lstat,chmod} from 'node:fs/promises';
import {qmdIndex} from '../../vendor/qmd';
import {hash,stableJson} from '../../domain/identity';

// Ranked candidates are shared by repeated searches and pagination. Original
// record/scope checks still run on every page in the vault and library readers.
const ttl=30*60*1000, maxEntries=128, maxBytes=512*1024;
const pending=new Map<string,Promise<unknown>>();
export async function indexRevision(database:string):Promise<string|undefined> {
  const stat=await lstat(database),index=qmdIndex(database);
  try {const revision=index.revision();return revision===undefined?undefined:`${stat.dev}:${stat.ino}:${revision}`;}
  finally {index.close();}
}
export async function cachedSearch(database:string,identity:unknown,search:()=>Promise<unknown>) {
  const revision=await indexRevision(database);
  // Existing indexes acquire revision tracking on their next maintenance pass.
  if(revision===undefined)return search();
  const key=hash(stableJson([3,revision,identity])),path=database+'.search-cache.sqlite';
  const inflight=pending.get(path+key);if(inflight)return inflight;
  const task=(async()=>{
    const info=await lstat(path).catch(e=>{if(e.code!=='ENOENT')throw e;return undefined;});
    if(info && (!info.isFile() || info.isSymbolicLink()))throw Error('Search cache must be an ordinary file');
    const db=new Database(path,{create:true});await chmod(path,0o600);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS results(key TEXT PRIMARY KEY,value TEXT NOT NULL,created INTEGER NOT NULL)');
      db.query('DELETE FROM results WHERE created<?').run(Date.now()-ttl);
      const saved=db.query('SELECT value FROM results WHERE key=?').get(key) as {value:string}|null;
      if(saved && revision===await indexRevision(database))return JSON.parse(saved.value);
      const result=await search(),value=JSON.stringify(result);
      // A concurrent update must not publish a result under its old revision.
      if(Buffer.byteLength(value)<=maxBytes && revision===await indexRevision(database)) {
        db.transaction(()=>{
          db.query('INSERT OR REPLACE INTO results VALUES(?,?,?)').run(key,value,Date.now());
          db.exec(`DELETE FROM results WHERE key IN (SELECT key FROM results ORDER BY created DESC LIMIT -1 OFFSET ${maxEntries})`);
        })();
      }
      return result;
    } finally {db.close();}
  })();
  pending.set(path+key,task);
  try{return await task;}finally{pending.delete(path+key);}
}
