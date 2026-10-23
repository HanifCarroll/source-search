import {test,expect} from "bun:test";
import {mkdtemp,rm,writeFile,readFile,stat,symlink,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {defaultConfig} from "../src/platform/config";
import {defaultConfig as fixtureConfig} from "./helpers/config";
import {createRuntime} from "../src/application/runtime";
import {rebuildArchive,indexStatus} from "../src/sources/archives/index";
import {syncLibrary} from "../src/maintenance/library-sync";
import {publish,libraryDB} from "../src/search/library/store";
import {readLibrary,searchLibrary} from "../src/search/library/index";
import { querySchema, type RecordData } from "../src/domain/contracts";
import {privateDirectory} from "../src/platform/storage";
import {Database} from "bun:sqlite";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

test("unconfigured runtime does not probe providers and rejects groups and guessed references",async()=>{
 let calls=0;const config=defaultConfig(),rt=createRuntime(config,async()=>{calls++;throw Error("must not execute");});
 const catalogue=await rt.list_sources();expect(catalogue.sources.every(s=>s.state==="disabled")).toBe(true);
 const search=await rt.search_sources({queries:[{source:"all-mail",query:"fixture"},{source:"messages",query:"fixture"}]});
 expect(search.results.every(s=>s.error?.code==="SOURCE_DISABLED")).toBe(true);
 for(const source of ["mail-personal","messages","library","documents","takeout-archive","vault"])
  await expect(rt.read_record({ref:{source,id:"guessed"}})).rejects.toThrow("Enable this source");
 expect(calls).toBe(0);
 await expect(rebuildArchive(config)).rejects.toThrow("Enable maintenance");
 await expect(syncLibrary(config)).rejects.toThrow("Enable maintenance");
});

test("rebuild ignores configured but disabled archives",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-release-"));try{
  const c={...defaultConfig(),maintenanceEnabled:true,index:join(root,"archive.sqlite"),things:join(root,"missing"),chatgpt:[join(root,"missing.zip")]};
  expect((await rebuildArchive(c)).indexedRecords).toBe(0);
  expect((await indexStatus(c)).count).toBe("0");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("disabling a source blocks old library references including archive shortcut reads",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-release-"));try{
  const c={...fixtureConfig(),libraryEnabled:true,libraryRoot:root};
  const r:RecordData={ref:{source:"takeout-archive",id:"fixture"},title:"Synthetic mail",body:"Invented private text",type:"email",locator:"fixture",observedAt:"fixture"};
  await publish(c,"takeout-archive",[r],{archive:"takeout-archive",signature:"fixture"});
  const db=libraryDB(c),row=db.query("SELECT id,hash FROM chunks").get() as any;db.close();
  const disabled={...c,enabledSources:c.enabledSources.filter(s=>s!=="takeout-archive")};
  await expect(readLibrary(disabled,{source:"library",id:row.id,version:row.hash},async()=>{})).rejects.toThrow("Enable this source");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("disabled source snippets never escape through global library discovery",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-release-"));try{
  const c={...fixtureConfig(),libraryEnabled:true,libraryRoot:root,libraryDatabase:join(root,"qmd.sqlite")};
  for(const source of ["whatsapp","calls"] as const)await publish(c,source,[{ref:{source,id:"fixture"},title:source,body:"Invented text",type:"message",locator:"fixture",observedAt:"fixture"}],{});
  const db=libraryDB(c),rows=db.query("SELECT * FROM chunks").all() as any[];db.close();
  const qmd=new Database(c.libraryDatabase);qmd.exec("CREATE TABLE documents(collection,path,hash,active);CREATE TABLE content_vectors(hash)");
  for(const row of rows)qmd.query("INSERT INTO documents VALUES(?,?,?,1)").run("ss-"+row.source,row.id+".md",row.hash);qmd.close();
  const disabled={...c,enabledSources:c.enabledSources.filter(s=>s!=="whatsapp")};
  const page=await searchLibrary(disabled,querySchema.parse({source:"library",query:"fixture",mode:"lexical"}),async()=>rows.map(r=>({file:`qmd://ss-${r.source}/${r.id}.md`,score:1,snippet:r.source==="whatsapp"?"DO NOT DISCLOSE":"Allowed fixture"})));
  expect(page.items).toHaveLength(1);expect(JSON.stringify(page)).not.toContain("DO NOT DISCLOSE");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("account routing is configured and no-send flags remain enforced",async()=>{
 const c={...defaultConfig(),enabledSources:["mail-personal" as const],mailAccounts:{"mail-personal":{account:"fixture-account",email:"reader@example.test",aliases:[]}}};
 let args:string[]=[];const rt=createRuntime(c,async argv=>{args=argv;return {messages:[]};});
 await rt.search_sources({queries:[{source:"mail-personal",query:"fixture"}]});
 expect(args[args.indexOf("--account")+1]).toBe("fixture-account");expect(args).toContain("--gmail-no-send");
});

test("private cache directories reject permissive roots and parent symlinks",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-release-"));try{
  const publicDir=join(root,"public");await mkdir(publicDir,{mode:0o755});
  await expect(privateDirectory(publicDir)).rejects.toThrow("private");
  await symlink(root,join(root,"link"));await expect(privateDirectory(join(root,"link","nested"))).rejects.toThrow("ordinary");
  await privateDirectory(join(root,"private"));expect((await stat(join(root,"private"))).mode&0o777).toBe(0o700);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("MCP reload immediately revokes an enabled source on config change",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-release-")),file=join(root,"config.json");let client:Client|undefined;
 try{
  await writeFile(join(root,"2024-01-01.md"),"Invented violet comet");
  await writeFile(file,JSON.stringify({journals:root,enabledSources:["journals"]}));
  client=new Client({name:"release-fixture",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,"../src/mcp.ts")],env:{SOURCE_SEARCH_CONFIG_FILE:file,HOME:root,PATH:process.env.PATH!},stderr:"pipe"}));
  const search=JSON.parse(((await client.callTool({name:"search_sources",arguments:{queries:[{source:"journals",query:"violet"}]}})).content as any)[0].text);
  const ref=search.results[0].items[0].ref;
  await writeFile(file,JSON.stringify({journals:root,enabledSources:[]}));
  const read=await client.callTool({name:"read_record",arguments:{ref}});
  expect(read.isError).toBe(true);expect(JSON.stringify(read)).toContain("SOURCE_DISABLED");expect(JSON.stringify(read)).not.toContain("violet comet");
 }finally{await client?.close();await rm(root,{recursive:true,force:true});}
});

test("cache purge is preview-first, owned, and refuses originals inside its target",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ss-purge-fixture-"));
 const file=join(root,"config.json"),cache=join(root,".cache/source-search");
 async function cli(...args:string[]){
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),...args],{env:{HOME:root,PATH:process.env.PATH!,SOURCE_SEARCH_CONFIG_FILE:file},stdout:"pipe",stderr:"pipe"});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  return {code,data:JSON.parse(out||err)};
 }
 try{
  await writeFile(file,JSON.stringify({maintenanceEnabled:true}));
  expect((await cli("rebuild")).code).toBe(0);
  expect((await cli("purge-cache")).data.data.applied).toBe(false);
  expect((await stat(join(cache,"archive-index.sqlite"))).isFile()).toBe(true);
  await writeFile(file,JSON.stringify({journals:join(cache,"originals")}));
  expect((await cli("purge-cache","--apply")).data.error.code).toBe("UNSAFE_PATH");
  await writeFile(file,"{}");
  expect((await cli("purge-cache","--apply")).data.data.applied).toBe(true);
  await expect(stat(cache)).rejects.toThrow();
  expect(await readFile(file,"utf8")).toBe("{}");
  await mkdir(cache,{mode:0o700});
  expect((await cli("purge-cache","--apply")).code).not.toBe(0);
  expect((await stat(cache)).isDirectory()).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
