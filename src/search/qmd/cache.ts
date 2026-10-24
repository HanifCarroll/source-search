import {Database} from 'bun:sqlite';
import {lstat,chmod} from 'node:fs/promises';
import {hash,stableJson} from '../../domain/identity';

// Ranked candidates are shared by repeated searches and pagination. Original
// record/scope checks still run on every page in the vault and library readers.
const ttl=30*60*1000, maxEntries=128, maxBytes=512*1024;
const pending=new Map<string,Promise<unknown>>();
export function installSearchRevision(db:{exec(sql:string):unknown}) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_search_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO source_search_revision VALUES(1,0);`);
  for(const table of ['documents','content_vectors'])for(const event of ['INSERT','UPDATE','DELETE']) {
    // A touched timestamp is not a content change. Vector writes always count.
    const when=event==='UPDATE' && table==='documents' ? 'WHEN old.hash IS NOT new.hash OR old.active IS NOT new.active OR old.title IS NOT new.title OR old.collection IS NOT new.collection OR old.path IS NOT new.path' : '';
    db.exec(`CREATE TRIGGER IF NOT EXISTS source_search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} ${when} BEGIN UPDATE source_search_revision SET revision=revision+1 WHERE id=1; END;`);
  }
}
export async function indexRevision(database:string):Promise<string|undefined> {
  const stat=await lstat(database),db=new Database(database,{create:false,strict:true});
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10000');
    if(!db.query("SELECT 1 FROM sqlite_master WHERE name='source_search_revision'").get())return undefined;
    return `${stat.dev}:${stat.ino}:`+(db.query('SELECT revision FROM source_search_revision WHERE id=1').get() as {revision:number}).revision;
  } finally {db.close();}
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
