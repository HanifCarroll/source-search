import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./helpers/config";
import { querySchema, hash } from "../src/shared";
import { annotateDuplicates, progress } from "../src/presentation";
import { validateOptions } from "../src/query";
import { qmdPath, qmdStatus, searchQmd, readQmd } from "../src/qmd";
import { searchCass, readCass } from "../src/cass";
import type { CassRunnerRequest } from "../src/vendor/cass/contracts";

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"source-search-hybrid-")),root=join(dir,"notes");await mkdir(root);
  const c={...defaultConfig(),qmdDatabase:join(dir,"index.sqlite"),qmdRoots:{notes:root},qmdModels:[join(dir,"embed"),join(dir,"expand"),join(dir,"rerank")]};
  for(const f of c.qmdModels)await writeFile(f,"synthetic model marker");
  const db=new Database(c.qmdDatabase);
  db.exec("CREATE TABLE documents(collection TEXT,path TEXT,title TEXT,hash TEXT,active INTEGER); CREATE TABLE content(hash TEXT,doc TEXT); CREATE TABLE content_vectors(hash TEXT); CREATE TABLE vectors_vec(id INTEGER); PRAGMA journal_mode=WAL;");
  for(const [filename,body] of [["A Thought.md","# A Thought\nPractice leads to insight."],["B Thought.md","# B Thought\nExperience improves decisions."]]) {
    await writeFile(join(root,filename!),body!);const h=hash(body!);
    db.query("INSERT INTO documents VALUES (?,?,?,?,1)").run("notes",qmdPath(filename!),filename!,h);
    db.query("INSERT INTO content VALUES (?,?)").run(h,body!);db.query("INSERT INTO content_vectors VALUES (?)").run(h);
  }
  db.close();
  const result=[{file:"qmd://notes/a-thought.md",score:.9,snippet:"Practice leads to insight."},{file:"qmd://notes/b-thought.md",score:.8,snippet:"Experience improves decisions."}];
  return {c,dir,root,result};
}
test("QMD hybrid discovery preserves original paths, paginates, and refuses stale originals",async()=>{
 const {c,dir,root,result}=await fixture();const calls:string[][]=[];
 try{
  const execute=async(argv:string[])=>{calls.push(argv);return result;};
  const q=querySchema.parse({source:"vault",query:"learning from doing",limit:1});
  const first=await searchQmd(c,q,execute);expect(first.retrieval?.effectiveMode).toBe("hybrid");
  expect(calls[0]).toContain("query");expect(calls[0]!.slice(-2)).toEqual(["--","learning from doing"]);
  expect((await readQmd(c,first.items[0]!.ref)).locator).toBe(join(root,"A Thought.md"));
  const second=await searchQmd(c,{...q,cursor:first.nextCursor},execute);expect(second.items[0]!.ref.id).toBe("qmd://notes/b-thought.md");expect(second.nextCursor).toBeUndefined();
  const doc=await readQmd(c,first.items[0]!.ref);expect(doc.body).toContain("Practice");
  await expect(searchQmd(c,{...q,mode:"lexical",cursor:first.nextCursor},execute)).rejects.toThrow("Cursor");
  await writeFile(join(root,"A Thought.md"),"Changed original");await expect(readQmd(c,first.items[0]!.ref)).rejects.toThrow("Original changed");
  await expect(readQmd(c,{source:"vault",id:"qmd://outside/secret.md"})).rejects.toThrow("Unconfigured");
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("QMD refuses missing embeddings/models instead of claiming hybrid and keeps lexical usable",async()=>{
 const {c,dir,result}=await fixture();let calls=0;const execute=async()=>{calls++;return result;};
 try{
  expect((await qmdStatus(c)).semanticReady).toBe(true);await rm(c.qmdModels[0]!);
  await expect(searchQmd(c,querySchema.parse({source:"vault",query:"insight"}),execute)).rejects.toThrow("not ready");expect(calls).toBe(0);
  expect((await searchQmd(c,querySchema.parse({source:"vault",query:"insight",mode:"lexical"}),execute)).retrieval?.effectiveMode).toBe("lexical");
  await writeFile(c.qmdModels[0]!,"synthetic");const db=new Database(c.qmdDatabase);db.exec("DELETE FROM content_vectors");db.close();
  expect((await qmdStatus(c)).pendingEmbeddings).toBe(2);await expect(searchQmd(c,querySchema.parse({source:"vault",query:"insight",mode:"semantic"}),execute)).rejects.toThrow("not ready");
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("QMD rejects normalized path collisions and linked originals",async()=>{
 const {c,dir,root,result}=await fixture();
 try{
  await writeFile(join(root,"A-Thought.md"),"different");await expect(searchQmd(c,querySchema.parse({source:"vault",query:"insight"}),async()=>result)).rejects.toThrow("Two originals");
  await rm(join(root,"A-Thought.md"));await rm(join(root,"A Thought.md"));await writeFile(join(dir,"outside.md"),"outside");await symlink(join(dir,"outside.md"),join(root,"A Thought.md"));
  await expect(readQmd(c,{source:"vault",id:"qmd://notes/a-thought.md"})).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("search mode and unsupported filters never silently affect the wrong provider",()=>{
 expect(()=>validateOptions(querySchema.parse({source:"mail-personal",query:"idea",mode:"hybrid"}))).not.toThrow();
 expect(()=>validateOptions(querySchema.parse({source:"vault",query:"idea",from:"2026-01-01T00:00:00Z"}))).toThrow("date/section");
 expect(()=>validateOptions(querySchema.parse({source:"vault",query:"idea",sort:"relevance",mode:"hybrid"}))).not.toThrow();
});
test("CASS preserves hybrid mode in context reads and exposes lexical fallback",async()=>{
 const calls:CassRunnerRequest[]=[];
 const runner=async(r:CassRunnerRequest)=>{calls.push(r);const data=r.args.includes("health")?{healthy:true,initialized:true,index:{exists:true,documents:10,stale:false},database:{exists:true,opened:true}}:r.args.includes("search")?{hits:[{title:"Fixture",snippet:"Synthetic result",source_path:"/synthetic/session",line_number:1,agent:"codex",source_id:"fixture",origin_kind:"local"}],total_matches:1,_meta:{search_mode:"lexical",requested_search_mode:"hybrid",fallback_reason:"Synthetic missing vectors",next_cursor:null}}:{path:"/synthetic/session",target_line:1,context:0,total_lines:1,source_exists:true,archive_only:false,lines:[{line:1,content:"Synthetic result",highlighted:true}]};return {exitCode:0,stdout:JSON.stringify(data),stderr:"",timedOut:false,outputLimitExceeded:false};};
 const q=querySchema.parse({source:"agent-history",query:"fixture"});const page=await searchCass(defaultConfig(),q,runner);
 expect(page.retrieval).toEqual({requestedMode:"hybrid",effectiveMode:"lexical",fallbackReason:"Synthetic missing vectors"});expect(page.warnings.some(w=>w.includes("Requested hybrid"))).toBe(true);
 await readCass(defaultConfig(),page.items[0]!.ref,false,runner);
 expect(calls.filter(c=>c.args.includes("search")).every(c=>c.args.includes("--mode=hybrid")&&c.args.includes("--no-maintenance"))).toBe(true);
});

test("QMD and a native journal hit are one lineage, and bounded ranking is not complete coverage",()=>{
 const ref={source:"vault" as const,id:"qmd://notes/test.md"};
 const hits=[{ref,title:"Test",type:"vault-document",metadata:{openLink:"/synthetic/Test.md"}},{ref:{source:"journals" as const,id:"Test.md"},title:"Test",type:"written-journal",metadata:{openLink:"/synthetic/Test.md"}}];
 annotateDuplicates(hits);expect((hits[0]!.metadata as any).duplicateEvidence[0].reason).toContain("one evidence lineage");
 const page=progress({source:"vault",status:"ok",items:[],warnings:[],observedAt:"synthetic"},querySchema.parse({source:"vault",query:"idea"}));
 expect(page.progress?.continuation).toBe("ranked-candidates-exhausted");expect(page.query?.mode).toBe("hybrid");expect(page.query?.sort).toBe("relevance");expect(page.query?.match).toBe("provider-native");
});
