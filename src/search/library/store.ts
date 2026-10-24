import {privateDirectory} from "../../platform/storage";
import {randomUUID} from "node:crypto";
import { lstatSync,chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { writeFile, rename, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import {sourceScope, type Config} from "../../platform/config";
import { hash, now, stableJson } from "../../domain/identity";
import { type RecordData, type Ref } from "../../domain/contracts";
import { contentSections } from "../../domain/content";

export function libraryDB(c:Config, write=false) {
 const path=join(c.libraryRoot,"library.sqlite");if(!write){const st=lstatSync(path);if(!st.isFile() || st.isSymbolicLink())throw Error("Library cache must be an existing regular file");}
 if(write){const st=lstatSync(c.libraryRoot);if(!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077)throw Error("Library root must be private (0700)");try{const f=lstatSync(path);if(!f.isFile() || f.isSymbolicLink())throw Error("Unsafe library file");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
 const db=new Database(path,{create:write,strict:true});if(write)chmodSync(path,0o600);
 if(write){db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,source TEXT,title TEXT,body TEXT,hash TEXT,refs TEXT,guard TEXT); CREATE TABLE IF NOT EXISTS states(source TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS mail(source TEXT,id TEXT,data TEXT,summary TEXT,seen TEXT,PRIMARY KEY(source,id));");}
 else db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000");
 return db;
}
export function getState(db:Database,source:string):any {const r=db.query("SELECT data FROM states WHERE source=?").get(source) as any;return r?JSON.parse(r.data):{};}
export function setState(db:Database,source:string,data:unknown){db.query("INSERT OR REPLACE INTO states VALUES(?,?)").run(source,JSON.stringify(data));}
export type Chunk={id:string;source:string;title:string;body:string;hash:string;refs:Ref[];guard:unknown};
export function makeChunks(source:string,records:RecordData[],guard:unknown):Chunk[]{
 const groups=new Map<string,RecordData[]>();
 for(const r of records){
  if(!r.body.trim())continue;
  const grouped=!!r.conversation && ["messages","whatsapp","chatgpt-archive","linkedin-archive"].includes(r.adapter || source);
  const key=grouped?r.conversation+":"+(r.occurredAt||"undated").slice(0,10):(r.adapter || source)==="linkedin-archive" && !/post|article/.test(r.type)?r.type+":"+(r.occurredAt||"undated").slice(0,10):r.ref.id;
  const g=groups.get(key)||[];g.push(r);groups.set(key,g);
 }
 const output:Chunk[]=[];
 for(const [group,rs] of groups){
  rs.sort((a,b)=>(a.occurredAt||"").localeCompare(b.occurredAt||"")||a.ref.id.localeCompare(b.ref.id));
  let parts:string[]=[],refs:Ref[]=[],size=0,ordinal=0;
  const title=rs[0]!.title.slice(0,180);
  const flush=()=>{if(!parts.length)return;const body=`# ${title}\n\nDerived search text. Source: ${source}. Read original references before citing.\n\n`+parts.join("\n\n");output.push({id:hash(source+":"+group+":"+ordinal++),source,title,body,hash:hash(body),refs,guard});parts=[];refs=[];size=0;};
  for(const r of rs){
   // Preserve section provenance, roles, branches and identifiers; never turn a summary into a transcript.
   const text=contentSections(r).filter(s=>s.kind!=="metadata").map(s=>`[${s.kind}]\n`+r.body.slice(s.start,s.end)).join("\n\n");
   const header=`## ${r.title.slice(0,180)}\nAuthor: ${r.author||"unspecified"}\nDate: ${r.occurredAt||"unspecified"}\nOriginal: ${JSON.stringify(r.ref)}\n${r.metadata?.selectedBranch!==undefined?`Selected branch: ${r.metadata.selectedBranch}\n`:""}`;
   for(let offset=0;offset<text.length;){
    let end=Math.min(text.length,offset+10000);if(end<text.length){const line=text.lastIndexOf("\n",end);if(line>offset+5000)end=line+1;}
    const part=header+(offset?`Continuation at character ${offset}\n`:"")+text.slice(offset,end);
    if(size+part.length>14000 || refs.length>=20)flush();
    parts.push(part);if(!refs.some(x=>x.id===r.ref.id))refs.push(r.ref);size+=part.length;offset=end;
   }
  }flush();
 }
 return output;
}
export async function publish(c:Config,source:string,records:RecordData[],guard:unknown,extra:Record<string,unknown>={}){
 guard={...(guard as object),scope:sourceScope(c,source)};
 const chunks=makeChunks(source,records,guard),folder=join(c.libraryRoot,"collections","ss-"+source);
 await privateDirectory(c.libraryRoot);await privateDirectory(folder);const db=libraryDB(c,true);
 try{
  const old=new Map((db.query("SELECT id,hash,body,refs,guard FROM chunks WHERE source=?").all(source) as any[]).map(r=>[r.id,r]));
  const changed:Chunk[]=[];
  let next=0;
  await Promise.all(Array.from({length:16},async()=>{while(next<chunks.length){const ch=chunks[next++]!;if(old.get(ch.id)?.hash!==ch.hash){const p=join(folder,ch.id+".md");await writeFile(p+".tmp",ch.body,{mode:0o600});await rename(p+".tmp",p);}
    const previous=old.get(ch.id);if(!previous || previous.hash!==ch.hash || previous.body!==ch.body || previous.refs!==JSON.stringify(ch.refs) || stableJson(JSON.parse(previous.guard))!==stableJson(ch.guard))changed.push(ch);
    old.delete(ch.id);}}));
  // Files precede manifest commit. Readers compare QMD hash with manifest and reject a mid-update mismatch.
  db.transaction(()=>{for(const id of old.keys())db.query("DELETE FROM chunks WHERE source=? AND id=?").run(source,id);const put=db.query("INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?,?)");for(const ch of changed)put.run(ch.id,ch.source,ch.title,ch.body,ch.hash,JSON.stringify(ch.refs),JSON.stringify(ch.guard));setState(db,source,{...getState(db,source),...extra,records:records.length,textRecords:records.filter(r=>r.body.trim()).length,chunks:chunks.length,publishedAt:changed.length||old.size?now():getState(db,source).publishedAt||now(),projectionRevision:changed.length||old.size?randomUUID():getState(db,source).projectionRevision||randomUUID(),guard});})();
  const live=new Set(chunks.map(ch=>ch.id+".md"));
  for(const name of await readdir(folder))if(/^[a-f0-9]{64}\.md(?:\.tmp)?$/.test(name) && !live.has(name))await rm(join(folder,name),{force:true});
 }finally{db.close();}
 return chunks.length;
}
export async function privateJSON(path:string,value:unknown){const temp=path+"."+randomUUID()+".tmp";try{await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600,flag:"wx"});await rename(temp,path);}finally{await rm(temp,{force:true});}}
