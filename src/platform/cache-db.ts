import {lstatSync,chmodSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import type {Config} from './config';
// Keep the installed cache path/schema; mail synchronization does not depend on search.
export function cacheDB(c:Config, write=false) {
 const path=join(c.libraryRoot,"library.sqlite");if(!write){const st=lstatSync(path);if(!st.isFile() || st.isSymbolicLink())throw Error("Library cache must be an existing regular file");}
 if(write){const st=lstatSync(c.libraryRoot);if(!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077)throw Error("Library root must be private (0700)");try{const f=lstatSync(path);if(!f.isFile() || f.isSymbolicLink())throw Error("Unsafe library file");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
 const db=new Database(path,{create:write,strict:true});if(write)chmodSync(path,0o600);
 if(write){db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,source TEXT,title TEXT,body TEXT,hash TEXT,refs TEXT,guard TEXT); CREATE TABLE IF NOT EXISTS states(source TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS mail_states(source TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS mail(source TEXT,id TEXT,data TEXT,summary TEXT,seen TEXT,PRIMARY KEY(source,id));");}
 else db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000");
 return db;
}
export {getProjectionState as getState,setProjectionState as setState} from './cache-state';
