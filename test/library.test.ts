import {test,expect} from "bun:test";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {defaultConfig} from "./helpers/config";
import {makeChunks,publish,libraryDB} from "../src/library-store";
import {readLibrary,searchLibrary,libraryStatus} from "../src/library";
import {querySchema,type RecordData} from "../src/shared";
import {validateOptions} from "../src/query";
const rec=(id:string,body:string):RecordData=>({ref:{source:"whatsapp",id,version:id},title:"Synthetic chat",body,type:"message",locator:"synthetic",author:"Fixture speaker",conversation:"fixture",occurredAt:"2026-01-01T00:00:00Z",observedAt:"synthetic"});
test("projections preserve every passage, source reference and section, and bound conversation groups",()=>{
 const records=Array.from({length:45},(_,i)=>rec(String(i),"Invented message "+i));records.push({...rec("long","z".repeat(31000)),sections:[{kind:"generated",start:0,end:31000}]});
 const chunks=makeChunks("whatsapp",records,{});
 expect(chunks.every(c=>c.refs.length<=20)).toBe(true);
 expect(new Set(chunks.flatMap(c=>c.refs.map(r=>r.id))).size).toBe(46);
 expect(chunks.map(c=>c.body).join("").match(/z/g)?.length).toBe(31000);
 expect(chunks.some(c=>c.body.includes("[generated]"))).toBe(true);
 expect(chunks[0]!.body).toContain("Author: Fixture speaker");
});
test("publication removes deleted chunks; stale refs fail; source validation gates derived reads",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-library-")),c={...defaultConfig(),libraryRoot:root,libraryEnabled:true};
 try{
  await publish(c,"whatsapp",[rec("1","Original invented statement")],{});
  let db=libraryDB(c);const row=db.query("SELECT id,hash FROM chunks").get() as any;db.close();
  const ref={source:"library" as const,id:row.id,version:row.hash};let checked=0;
  const r=await readLibrary(c,ref,async original=>{checked++;expect(original.id).toBe("1");});expect(checked).toBe(1);expect(r.metadata!.derived).toBe(true);
  await expect(readLibrary(c,ref,async()=>{throw Error("changed original");})).rejects.toThrow("changed original");
  await publish(c,"whatsapp",[rec("1","Changed invented statement")],{});
  await expect(readLibrary(c,ref,async()=>{})).rejects.toThrow("Original changed");
  await publish(c,"whatsapp",[],{});db=libraryDB(c);expect((db.query("SELECT count(*) n FROM chunks").get() as any).n).toBe(0);db.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test("ranked projection search uses collection scope, withholds stale index text and exposes pending vectors",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-library-")),c={...defaultConfig(),libraryRoot:root,libraryEnabled:true,libraryDatabase:join(root,"qmd.sqlite"),qmdModels:[join(root,"embed"),join(root,"expand"),join(root,"rerank")]};
 try{
  for(const path of c.qmdModels)await writeFile(path,"synthetic marker");
  await publish(c,"whatsapp",[rec("1","Synthetic idea")],{}, {state:"ready"});let d=libraryDB(c);const row=d.query("SELECT * FROM chunks").get() as any;d.close();
  const db=new Database(c.libraryDatabase);db.exec("CREATE TABLE documents(collection,path,hash,active);CREATE TABLE content_vectors(hash)");db.query("INSERT INTO documents VALUES(?,?,?,1)").run("ss-whatsapp",row.id+".md",row.hash);db.query("INSERT INTO content_vectors VALUES(?)").run(row.hash);db.close();
  let args:string[]=[];const execute=async(a:string[])=>{args=a;return [{file:"qmd://ss-whatsapp/"+row.id+".md",score:1,snippet:"Synthetic idea"}];};
  const q=querySchema.parse({source:"whatsapp",query:"thought",mode:"hybrid"});const page=await searchLibrary(c,q,execute);
  expect(args).toContain("ss-whatsapp");expect(page.items[0]!.ref.source).toBe("library");expect(page.retrieval!.effectiveMode).toBe("hybrid");
  await publish(c,"whatsapp",[rec("1","Changed idea")],{}, {state:"ready"});expect((await searchLibrary(c,q,execute)).items.length).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("hybrid never silently ignores exact filters or switches provider syntax",()=>{
 expect(()=>validateOptions(querySchema.parse({source:"mail-personal",query:"idea",mode:"hybrid"}))).not.toThrow();
 for(const option of [{from:"2026-01-01T00:00:00Z"},{roles:["user"]},{sections:["primary"]},{folders:["inbox"]}])expect(()=>validateOptions(querySchema.parse({source:"library",query:"idea",...option}))).toThrow("exact filters");
});

test("mail maintenance resumes failures and prunes only after a complete provider inventory",async()=>{
 const {syncMail}=await import("../src/library-sync");const {getState,setState}=await import("../src/library-store");
 const root=await mkdtemp(join(tmpdir(),"ss-mail-sync-")),c={...defaultConfig(),libraryRoot:root,libraryEnabled:true};await mkdir(join(root,"mail-raw"));
 let pass=0,failSecond=false;const calls:string[][]=[];
 const execute=async(argv:string[])=>{
  calls.push(argv);
  if(argv.includes("search")){
   if(argv.includes("--page")){if(failSecond)throw Error("Synthetic interrupted scan");return {messages:[]};}
   const ids=pass===0?["alpha","bravo"]:["bravo"];
   return {messages:ids.map(id=>({id,subject:"Synthetic "+id,from:"fixture@example.test",date:"2026-01-01 00:00",labels:[]})),...(pass?{nextPageToken:"second"}:{})};
  }
  const id=argv[argv.indexOf("get")+1];return {headers:{subject:"Synthetic "+id,from:"fixture@example.test",date:"2026-01-01T00:00:00Z"},message:{id,threadId:"fixture",internalDate:"1767225600000"},body:"Invented mailbox text"};
 };
 try{
  await syncMail(c,execute,["mail-personal"]);let db=libraryDB(c,true);expect((db.query("SELECT count(*) n FROM mail").get() as any).n).toBe(2);setState(db,"mail-personal",{...getState(db,"mail-personal"),nextScanAt:0});db.close();
  pass=1;failSecond=true;await syncMail(c,execute,["mail-personal"]);db=libraryDB(c);expect((db.query("SELECT count(*) n FROM mail").get() as any).n).toBe(2);expect(getState(db,"mail-personal").state).toBe("error");db.close();
  failSecond=false;await syncMail(c,execute,["mail-personal"]);db=libraryDB(c);expect((db.query("SELECT count(*) n FROM mail").get() as any).n).toBe(1);expect(getState(db,"mail-personal").state).toBe("ready");db.close();
  expect(calls.every(c=>!c.some(v=>["send","delete","archive","modify","trash"].includes(v)))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
