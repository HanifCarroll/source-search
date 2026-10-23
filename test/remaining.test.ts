import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "./helpers/config";
import { createRuntime } from "../src/application/runtime";
import { querySchema, type Ref } from "../src/domain/contracts";
import { rebuildArchive } from "../src/sources/archives/index";
import { exportRecords } from "../src/sources/archives/originals";
import { searchCass, readCass, cassStatus } from "../src/sources/agent-history/index";
import type { CassRunnerRequest } from "../src/vendor/cass/contracts";
import { createZip } from "./helpers/zip";
import { notesStatus } from "../src/sources/local/notes";
let root: string, c: Config;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "source-search-more-"));
  c = { ...defaultConfig(), things: join(root,"things"), index: join(root,"index.sqlite"), whatsapp: join(root,"wa.db"), muesli: join(root,"calls.db"), voiceNotes: join(root,"voice"), callNotes: join(root,"notes"), chromeProfiles: [join(root,"chrome")], pimLauncher: join(root,"launcher"), pimHelper: join(root,"helper"), cassBinary: join(root,"missing-cass"), cassData: join(root,"cass-data") };
  for (const p of [c.things,c.voiceNotes,c.callNotes,c.chromeProfiles[0]]) await mkdir(p);
  await writeFile(join(c.things,"tasks.jsonl"), ""); await writeFile(join(c.things,"context.json"),'{"TMTask":[]}'); await writeFile(join(c.things,"snapshot-info.json"),'{"exportedAt":"2026-10-11T00:00:00Z","taskCount":0}');
});
afterEach(async () => { await rm(root,{recursive:true,force:true}); });
const search = async (source: string, query = "fixture", extra = {}) => (await createRuntime(c).search_sources({queries:[{source,query,...extra}]})).results[0];

test("WhatsApp direct/group text, authors, continuation, context and unchanged original; deleted calls excluded", async () => {
  const db = new Database(c.whatsapp);
  db.exec("CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT); CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER); INSERT INTO ZWACHATSESSION VALUES(1,'group@g.us','Fixture group');");
  for(let i=1;i<=4;i++) db.query("INSERT INTO ZWAMESSAGE VALUES(?,1,?,700000000.25,?,?, 'friend',NULL)").run(i,"native"+i,i===4?1:0,"fixture "+i); db.close();
  const before = await readFile(c.whatsapp), first = await search("whatsapp","fixture",{limit:1}); expect(first.items[0].author).toBe("self"); expect(first.items[0].metadata?.group).toBe(true);
  const next = await search("whatsapp","fixture",{limit:1,cursor:first.nextCursor}); expect(next.items[0].ref.id).toBe("3");
  const r = await createRuntime(c).read_record({ref:first.items[0].ref,context:true}); expect(r.context).toHaveLength(3); expect(await readFile(c.whatsapp)).toEqual(before);
  const calls = new Database(c.muesli); calls.exec("CREATE TABLE meetings(id INTEGER,title TEXT,start_time TEXT,end_time TEXT,raw_transcript TEXT,formatted_notes TEXT,manual_notes TEXT,deleted_at INTEGER); INSERT INTO meetings VALUES(1,'Call','2024-01-01T00:00:00Z',NULL,'original fixture','Generated','Manual',NULL),(2,'Deleted',NULL,NULL,'fixture',NULL,NULL,1)"); calls.close();
  const p = await search("calls"); expect(p.items).toHaveLength(1); const call = await createRuntime(c).read_record({ref:p.items[0].ref}); expect(call.record.body).toContain("Original transcript\noriginal fixture"); expect(call.record.body).toContain("Generated meeting notes");
  const changed = new Database(c.muesli); changed.exec("UPDATE meetings SET raw_transcript='changed'"); changed.close(); await expect(createRuntime(c).read_record({ref:p.items[0].ref})).rejects.toThrow("changed");
});

test("Chrome profile reads preserve every visit, bookmarks and download metadata with stale references", async () => {
  const path = join(c.chromeProfiles[0],"History"), db = new Database(path);
  db.exec("CREATE TABLE urls(id INTEGER,title TEXT,url TEXT); CREATE TABLE visits(id INTEGER,url INTEGER,visit_time INTEGER); CREATE TABLE downloads(id INTEGER,start_time INTEGER,target_path TEXT); CREATE TABLE downloads_url_chains(id INTEGER,chain_index INTEGER,url TEXT); INSERT INTO urls VALUES(1,'Fixture page','https://example.test'); INSERT INTO visits VALUES(1,1,13348540800000000),(2,1,13348540800000000); INSERT INTO downloads VALUES(1,13348540800000000,'fixture.pdf'); INSERT INTO downloads_url_chains VALUES(1,0,'https://example.test/fixture.pdf')"); db.close();
  await writeFile(join(c.chromeProfiles[0],"Bookmarks"), JSON.stringify({roots:{bar:{children:[{id:"7",type:"url",name:"Fixture bookmark",url:"https://example.test",date_added:"13348540800000000"}]}}}));
  const before = await readFile(path), p = await search("chrome-history","fixture",{limit:1}), p2 = await search("chrome-history","fixture",{limit:1,cursor:p.nextCursor}); expect(p.items[0].ref.id).not.toBe(p2.items[0].ref.id);
  expect((await createRuntime(c).read_record({ref:p.items[0].ref})).record.body).toContain("https://example.test"); expect(await readFile(path)).toEqual(before);
  const downloads = await search("chrome-downloads"); expect(downloads.items[0].metadata?.downloadsAreMetadataOnly).toBe(true); expect((await createRuntime(c).read_record({ref:downloads.items[0].ref})).record.body).toContain("fixture.pdf");
  const b = await search("chrome-bookmarks"); expect(b.items).toHaveLength(1); await writeFile(join(c.chromeProfiles[0],"Bookmarks"),'{"roots":{}}'); await expect(createRuntime(c).read_record({ref:b.items[0].ref})).rejects.toThrow("absent");
});

test("voice and call notes retain original warnings, dates and long text", async () => {
  const text = '---\ndate: 2024-01-01\nsource_audio: app://original\n---\nquality_warnings: uncertain\nfixture '+"x".repeat(18000);
  await writeFile(join(c.voiceNotes,"2024-01-01 - Voice - Fixture.md"),text); await writeFile(join(c.callNotes,"Call.md"),"fixture call note");
  const p = await search("voice-journals"), r = await createRuntime(c).read_record({ref:p.items[0].ref}); expect(r.record.body).toContain("quality_warnings: uncertain"); expect(r.record.nextCursor).toBeDefined(); expect(r.record.metadata?.sourceLocator).toBe("app://original"); expect((await search("call-notes")).items).toHaveLength(1);
});

test("shared journal folders separate voice transcripts from daily and navigation notes", async () => {
  c.journals = c.voiceNotes;
  const folder = join(c.journals, "2024/01-January"); await mkdir(folder, { recursive: true });
  const voice = "2024/01-January/2024-01-01 - Voice - Fixture.md";
  const text = '---\ndate: 2024-01-01\nsource_audio: app://original\nquality_warnings: [uncertain]\n---\nfixture voice transcript';
  await writeFile(join(c.journals, voice), text);
  await writeFile(join(folder, "2024-01-01.md"), "fixture written journal");
  await writeFile(join(c.journals, "index.md"), "fixture navigation");
  await writeFile(join(c.journals, "2024-W01.md"), "fixture weekly note");
  const runtime = createRuntime(c);
  expect((await notesStatus(c, "voice-journals")).records).toBe(1);
  const p = await search("voice-journals", "fixture", { from: "2024-01-01T00:00:00-03:00", to: "2024-01-02T00:00:00-03:00" });
  expect(p.items.map(r => r.ref.id)).toEqual([voice]);
  expect((await search("journals")).items.map(r => r.ref.id)).toEqual(["2024/01-January/2024-01-01.md"]);
  expect((await runtime.read_record({ ref: p.items[0].ref })).record.body).toBe(text);
  expect(await readFile(join(c.journals, voice), "utf8")).toBe(text);
  await expect(runtime.read_record({ ref: { source: "voice-journals", id: "2024/01-January/2024-01-01.md" } })).rejects.toThrow("transcript note");
  await expect(runtime.read_record({ ref: { source: "voice-journals", id: "index.md" } })).rejects.toThrow("transcript note");
});

async function native(lines: any[]) {
  await writeFile(c.pimLauncher, '#!/bin/sh\nexec /bin/cat '+JSON.stringify(join(root,"native.jsonl"))+'\n'); await chmod(c.pimLauncher,0o700); await writeFile(join(root,"native.jsonl"),lines.map(x=>JSON.stringify(x)).join("\n")+"\n");
}
test("native contacts and calendar occurrences validate date windows and expose incomplete permission scans", async () => {
  await native([{type:"contact",identifier:"c1",displayName:"Fixture",emails:["fixture@example.test"]},{type:"scan_finished",source:"contacts",complete:true,scanned:1}]);
  const p = await search("contacts"); expect(p.items).toHaveLength(1); expect((await createRuntime(c).read_record({ref:p.items[0].ref})).record.body).toContain("fixture@example.test");
  expect((await search("contacts","",{from:"2024-01-01T00:00:00Z"})).error?.code).toBe("UNSUPPORTED_FILTER");
  await native([{type:"calendar_event",id:"e1",title:"Fixture",start:"2024-01-01T00:00:00Z",calendar:{identifier:"a"}},{type:"calendar_event",id:"e1",title:"Fixture",start:"2024-01-02T00:00:00Z",calendar:{identifier:"a"}},{type:"scan_finished",source:"calendar",complete:true,scanned:2}]);
  expect((await search("calendar")).error?.code).toBe("REQUIRED_FILTER"); const events = await search("calendar","fixture",{from:"2024-01-01T00:00:00Z",to:"2024-02-01T00:00:00Z"}); expect(events.items).toHaveLength(2); expect(events.items[0].ref.id).not.toBe(events.items[1].ref.id);
  await native([{type:"calendar_event",id:"e1",title:"Fixture",start:"2024-01-01T00:00:00Z",calendar:{identifier:"a"},attendees:[{url:"b"},{url:"a"}],recurrence:["<EKRecurrenceRule: 0xABCD> weekly"]},{type:"scan_finished",source:"calendar",complete:true,scanned:1}]);
  const stable = await search("calendar","fixture",{from:"2024-01-01T00:00:00Z",to:"2024-02-01T00:00:00Z"});
  await native([{calendar:{identifier:"a"},start:"2024-01-01T00:00:00Z",title:"Fixture",id:"e1",type:"calendar_event",recurrence:["<EKRecurrenceRule: 0xEEEE> weekly"],attendees:[{url:"a"},{url:"b"}]},{type:"scan_finished",source:"calendar",complete:true,scanned:1}]);
  expect((await createRuntime(c).read_record({ref:stable.items[0].ref})).record.body).toContain("weekly");
  const bad: Ref = {source:"calendar",id:Buffer.from(JSON.stringify(["e1","2024","a",{from:"invalid",to:"also invalid"}])).toString("base64url")}; await expect(createRuntime(c).read_record({ref:bad})).rejects.toThrow();
  await native([{type:"error",code:"authorization-denied",source:"contacts",authorization:"denied",message:"Denied"}]); expect((await search("contacts")).error?.code).toBe("PERMISSION_DENIED");
});

function conversation() { return {id:"conv",title:"Fixture history",current_node:"b",mapping:{root:{id:"root",parent:null,children:["a"],message:null},a:{id:"a",parent:"root",children:["b","c"],message:{id:"ma",author:{role:"system"},create_time:null,content:{content_type:"text",parts:["Fixture system"]}}},b:{id:"b",parent:"a",children:[],message:{id:"mb",author:{role:"assistant"},create_time:1704067200,content:{content_type:"text",parts:["Fixture selected"]}}},c:{id:"c",parent:"a",children:[],message:{id:"mc",author:{role:"tool"},create_time:1704067200,content:{content_type:"text",parts:["Fixture alternate"]}}}}}; }
test("ChatGPT ZIP and folders preserve branches, all roles, unknown dates and stale originals", async () => {
  const path = join(root,"chatgpt"); await mkdir(path); await writeFile(join(path,"conversations.json"),JSON.stringify([conversation()])); c.chatgpt=[path]; await rebuildArchive(c);
  const p = await search("chatgpt-archive"); expect(p.items).toHaveLength(3); expect(p.items.some(r=>r.author==="system" && !r.occurredAt)).toBe(true); expect(p.items.some(r=>r.metadata?.selectedBranch===false)).toBe(true);
  const ref = p.items.find(r=>r.author==="tool")!.ref; expect((await createRuntime(c).read_record({ref})).record.body).toContain("alternate");
  const changed = conversation(); changed.mapping.c.message.content.parts=["changed"]; await writeFile(join(path,"conversations.json"),JSON.stringify([changed])); await expect(createRuntime(c).read_record({ref})).rejects.toThrow("changed");
  const zip = join(root,"chatgpt.zip"); await writeFile(zip,await createZip([{path:"conversations.json",text:JSON.stringify([conversation()]),method:8}])); c.chatgpt=[zip]; expect((await exportRecords(c,"chatgpt-archive")).records.size).toBe(3);
});

test("Takeout products retain nested Maps and contributions; malformed refresh and unsafe ZIP preserve previous index", async () => {
  const zip = join(root,"takeout.zip"); c.takeout=[zip];
  await writeFile(zip,await createZip([
    {path:"Takeout/Maps/Reviews.json",text:JSON.stringify({features:[{properties:{title:"Fixture cafe",comment:"Fixture nested review",starRating:5,date:"2024-01-01T00:00:00Z"},geometry:{coordinates:[1,2]}}]})},
    {path:"Takeout/Search Contributions/Contributions.json",text:'[{"searchTerm":"Fixture question","timestamp":"2024-01-02T00:00:00Z"}]'},
    {path:"Takeout/Mail/All mail Including Spam and Trash.mbox",text:'From sender@example.test Mon Jan 1 00:00:00 2024\nMessage-ID: <one>\nFrom: sender@example.test\nSubject: Fixture mail\nDate: Mon, 01 Jan 2024 00:00:00 +0000\n\nFixture email body\n'},
    {path:"Takeout/Calendar/Events.ics",text:'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20240101T000000Z\r\nSUMMARY:Fixture calendar\r\nEND:VEVENT\r\nEND:VCALENDAR'},
    {path:"Takeout/YouTube and YouTube Music/history/watch-history.html",text:'<div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=fixture">Fixture video</a><br>Jan 1, 2024, 12:00:00 AM UTC</div>'},
    {path:"Takeout/Mail/Gmail settings.json",text:'{"signature":"Fixture settings"}'},
    {path:"Takeout/Unknown/file.txt",text:'fixture unsupported'}
  ]));
  await rebuildArchive(c); const p=await search("takeout-archive"); expect(p.items.length).toBeGreaterThanOrEqual(6); expect(p.items.some(r=>r.type==="search-contribution")).toBe(true); const map=p.items.find(r=>r.type==="maps-review")!; expect(map.title).toBe("Fixture cafe"); expect((await createRuntime(c).read_record({ref:map.ref,details:true})).record.body).toContain('"starRating":5'); expect(p.sourceWarnings?.some(w=>w.includes("Unsupported"))).toBe(true);
  const before=await readFile(c.index); await writeFile(zip,await createZip([{path:"Maps/Reviews.json",text:"{invalid"}])); await expect(rebuildArchive(c)).rejects.toThrow("Malformed"); expect(await readFile(c.index)).toEqual(before);
  await writeFile(zip,await createZip([{path:"../outside.json",text:"{}"}])); await expect(exportRecords(c,"takeout-archive")).rejects.toThrow();
});

test("CASS stays read-only, gates rebuilding and validates query-bound context references", async () => {
  const calls: CassRunnerRequest[]=[]; let rebuilding=false;
  const runner=async(r:CassRunnerRequest)=>{calls.push(r); const data=r.args.includes("health") ? {healthy:!rebuilding,initialized:true,status:rebuilding?"rebuilding":"healthy",index:{exists:true},database:{opened:true}} : r.args.includes("search") ? {hits:[{title:"Fixture agent",snippet:"fixture",source_path:"/synthetic/session.jsonl",line_number:2,agent:"codex",source_id:"local",origin_kind:"local"}],total_matches:1,_meta:{next_cursor:null}} : {path:"/synthetic/session.jsonl",target_line:2,context:0,total_lines:3,source_exists:true,archive_only:false,lines:[{line:2,content:"Fixture original line",highlighted:true}]};return{exitCode:0,stdout:JSON.stringify(data),stderr:"",timedOut:false,outputLimitExceeded:false};};
  const q=querySchema.parse({source:"agent-history",query:"fixture"}), p=await searchCass(c,q,runner); expect(p.items).toHaveLength(1); expect((await readCass(c,p.items[0].ref,false,runner)).body).toContain("Fixture original line");
  expect(calls.filter(r=>r.args.includes("search")).every(r=>r.args.includes("--no-maintenance")&&r.args.includes("--no-daemon"))).toBe(true); expect(calls.every(r=>!r.args.includes("index")&&!r.args.includes("models"))).toBe(true);
  const view=calls.find(r=>r.args.includes("view"))!;expect(view.args).toContain('--message-index');expect(view.args).not.toContain('--line');expect(view.args).not.toContain('--data-dir');expect(view.args.indexOf('--db')).toBeLessThan(view.args.indexOf('view'));
  const malformed={source:"agent-history" as const,id:Buffer.from('{"q":{"source":"agent-history","query":"x","limit":10},"result":99,"fingerprint":"x"}').toString("base64url")}; await expect(readCass(c,malformed,false,runner)).rejects.toThrow("Invalid");
  rebuilding=true; expect((await cassStatus(c,runner)).available).toBe(false); await expect(searchCass(c,q,runner)).rejects.toThrow("rebuilding");
});


test("actual Takeout field aliases and nested MIME text remain searchable without attachment bytes", async () => {
  const zip = join(root,"actual-shapes.zip"); c.takeout = [zip];
  await writeFile(zip,await createZip([
    {path:"Takeout/Maps (your places)/Reviews.json",text:JSON.stringify({features:[{properties:{date:"2024-01-01T00:00:00Z",location:{name:"Fixture place",address:"Fixture street"},review_text_published:"Fixture review",five_star_rating_published:5}},{properties:{location:{name:"Fixture undated"},five_star_rating_published:5}}]})},
    {path:"Takeout/Search Contributions/Thumbs.json",text:JSON.stringify([{Published:"2024-01-02T00:00:00Z","Search Query":"Fixture question","Thumbs Rating":"positive"}])},
    {path:"Takeout/Mail/All mail Including Spam and Trash.mbox",text:'From fixture@example.test Mon Jan 1 00:00:00 2024\nFrom: fixture@example.test\nMessage-ID: <mixed>\nSubject: Mixed fixture\nContent-Type: multipart/mixed; boundary="outer"\n\n--outer\nContent-Type: multipart/alternative; boundary="inner"\n\n--inner\nContent-Type: text/plain\n\nFixture nested original body\n--inner--\n--outer\nContent-Type: application/octet-stream\nContent-Disposition: attachment; filename="private.bin"\nContent-Transfer-Encoding: base64\n\nU0VDUkVUX0FUVEFDSE1FTlQ=\n--outer\n<object>\n\nmalformed fixture MIME section\n--outer--\n'}
  ]));
  const r=await exportRecords(c,"takeout-archive"), values=[...r.records.values()];
  expect(values.find(r=>r.type==="maps-review")!.title).toBe("Fixture place"); expect(values.find(r=>r.title==="Fixture undated")!.occurredAt).toBeUndefined();
  const contribution=values.find(r=>r.type==="search-contribution")!; expect(contribution.title).toContain("Fixture question"); expect(contribution.occurredAt).toBe("2024-01-02T00:00:00.000Z");
  const mail=values.find(r=>r.type==="email")!; expect(mail.body).toContain("Fixture nested original body"); expect(mail.body).not.toContain("U0VDUkVUX0FUVEFDSE1FTlQ="); expect(mail.metadata?.headers).toBeDefined(); expect(mail.warnings?.length).toBeGreaterThan(0); expect(r.warnings.some(w=>w.includes("Incomplete MIME"))).toBe(true);
});
