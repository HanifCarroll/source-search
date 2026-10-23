import {test,expect,afterEach} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {defaultConfig} from "./helpers/config";
import {createRuntime} from "../src/application/runtime";
import { querySchema, type RecordData } from "../src/domain/contracts";
import { hit } from "../src/domain/results";
import {findRecordMatch} from "../src/domain/content";
import {readNote} from "../src/sources/local/notes";
import {annotateDuplicates,compactRecord,googleDocument,progress} from "../src/domain/presentation";
import {readablePim} from "../src/sources/local/pim";
import {linkedInRecords} from "../src/sources/archives/linkedin";
import {cassStatus,searchCass} from "../src/sources/agent-history/index";
import {describeSource} from "../src/application/catalogue";
import {searchMail} from "./helpers/mail";
import {rebuildArchive,searchArchive} from "../src/sources/archives/index";
import {exportRecords,readExport} from "../src/sources/archives/originals";
import {searchChrome,readChrome} from "../src/sources/local/chrome";
import {createZip} from "./helpers/zip";

const roots:string[]=[];
async function folder(){const root=await mkdtemp(join(tmpdir(),"source-search-dogfood-fixes-"));roots.push(root);return root;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});
function record(body:string,source:RecordData["ref"]["source"]):RecordData{return {ref:{source,id:"fixture"},title:"Fixture",body,type:source.startsWith("mail-")?"email":"message",locator:"source-search://fixture",observedAt:""};}

test("retained Muesli sections and native IDs separate metadata/generated notes from transcript",async()=>{
 const root=await folder(),c={...defaultConfig(),callNotes:root},body='---\nsource: muesli\nmuesli_meeting_id: 42\n---\n# Fixture Call\n## Source Metadata\nMeeting key: metadata-key\n## Muesli Generated Notes\nsummary-key\n## Original Transcript\nprimary-key';
 await writeFile(join(root,"Call.md"),body);const note=await readNote(c,{source:"call-notes",id:"Call.md"});
 expect(findRecordMatch(note,{query:"metadata-key",sections:["primary"]})).toBeUndefined();
 expect(findRecordMatch(note,{query:"metadata-key",sections:["metadata"]})?.section).toBe("metadata");
 expect(findRecordMatch(note,{query:"summary-key"})?.section).toBe("generated");expect(findRecordMatch(note,{query:"primary-key"})?.section).toBe("primary");
 const hits=[hit(note,querySchema.parse({source:"call-notes",query:"primary"}),1),hit({...record("primary","calls"),ref:{source:"calls",id:"42"}},querySchema.parse({source:"calls",query:"primary"}),1)];annotateDuplicates(hits);
 expect((hits[0].metadata?.duplicateEvidence as any[])[0].ref.id).toBe("42");expect(await readFile(join(root,"Call.md"),"utf8")).toBe(body);
});

test("mail footers are labelled, provider-only matches stay honest, and spam/trash require opt-in",async()=>{
 const r=record("Your invoice\r\n\r\nwww.example.test | Community: https://example.test/community\r\n","mail-personal"),q=querySchema.parse({source:"mail-personal",query:"community"});
 expect(findRecordMatch(r,{query:"community",sections:["primary"]})).toBeUndefined();const h=hit(r,q,1);expect(h.match.section).toBe("metadata");expect(h.focus).toBeDefined();
 expect(hit(r,{...q,query:"label:invoice"},1).match.field).toBe("provider");
 const calls:string[][]=[],execute=async(args:string[])=>{calls.push(args);return args.includes("fastmail")?{messages:[],position:0,queryState:"stable",total:0,nextPosition:null}:{messages:[]};};
 await searchMail(q,execute);await searchMail({...q,excludeSpamTrash:false},execute);await searchMail({...q,source:"mail-fastmail"},execute);await searchMail({...q,source:"mail-fastmail",excludeSpamTrash:false},execute);
 expect(calls[0].at(-1)).toContain("-in:spam -in:trash");expect(calls[1].at(-1)).toBe("community");expect(calls[2]).toContain("--exclude-spam-trash");expect(calls[3]).not.toContain("--exclude-spam-trash");
});

test("CASS stale fingerprint diagnosis and recovery never start maintenance",async()=>{
 const calls:string[][]=[],raw={healthy:false,status:"unhealthy",initialized:true,index:{exists:true,stale:true,reason:"database fingerprint changed since the last lexical checkpoint",fingerprint:{current_db_fingerprint:"current",checkpoint_fingerprint:"checkpoint"}},database:{exists:true,opened:true},rebuild:{active:false},recommended_action:"Run cass index"};
 const runner=async(r:any)=>{calls.push(r.args);return {exitCode:1,stdout:JSON.stringify(raw),stderr:"",timedOut:false,outputLimitExceeded:false};};
 const c=defaultConfig(),status=await cassStatus(c,runner),described=describeSource(c,{source:"agent-history",...status});
 expect(status.health.index.databaseFingerprint).toBe("current");expect(status.health.explanation).toContain("fingerprint");expect(described.state).toBe("stale");expect(described.recovery).toContain("Run cass index");expect(described.recovery).toContain("export indexes");
 await expect(searchCass(c,querySchema.parse({source:"agent-history",query:"fixture"}),runner)).rejects.toThrow("Refresh the configured CASS index");expect(calls.every(args=>!args.includes("index") && !args.includes("search"))).toBe(true);
 const fallback=await cassStatus(c,async(r:any)=>r.args.includes("status") ? {exitCode:1,stdout:"",stderr:"",timedOut:true,outputLimitExceeded:false} : runner(r));expect(fallback.available).toBe(false);expect(fallback.health.index.reason).toContain("fingerprint");expect(fallback.health.warnings[0]).toContain("readiness remains false");
});

test("Contacts default ordering and missing WhatsApp text give accurate guidance",async()=>{
 const p=progress({source:"contacts",status:"ok",items:[],warnings:[],observedAt:""},querySchema.parse({source:"contacts",query:""}));expect(p.query?.sort).toBe("source-order");
 const root=await folder(),c={...defaultConfig(),whatsapp:join(root,"wa.db")},db=new Database(c.whatsapp);
 db.exec("CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER);CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);INSERT INTO ZWACHATSESSION VALUES(1,'fixture@g.us','Fixture Builders');INSERT INTO ZWAMESSAGE VALUES(1,1,'message',700000000,0,NULL,NULL,NULL)");db.close();
 const result=(await createRuntime(c).search_sources({queries:[{source:"whatsapp",query:"",conversation:"fixture@g.us",sections:["primary"]}]})).results[0];expect(result.items).toHaveLength(0);expect(result.scan?.missingText).toBe(1);expect(result.warnings.some(w=>w.includes("cannot recover"))).toBe(true);expect(result.warnings.some(w=>w.includes("shorter word"))).toBe(false);
});

test("Google resource visits group consecutive nearby entries without losing references or continuation",async()=>{
 const root=await folder(),c={...defaultConfig(),chromeProfiles:[root]},path=join(root,"History"),db=new Database(path),url="https://drive.google.com/drive/folders/fixture_folder_id";
 db.exec("CREATE TABLE urls(id INTEGER,title TEXT,url TEXT);CREATE TABLE visits(id INTEGER,url INTEGER,visit_time INTEGER)");db.query("INSERT INTO urls VALUES(1,'Fixture folder',?)").run(url);db.query("INSERT INTO urls VALUES(2,'Fixture other','https://example.test')").run();
 for(const [id,page,time] of [[1,2,13348540000000000],[2,1,13348540800000000],[3,1,13348540805000000],[4,1,13348540810000000]])db.query("INSERT INTO visits VALUES(?,?,?)").run(id,page,time);db.close();
 const before=await readFile(path),q=querySchema.parse({source:"chrome-history",query:"fixture",limit:1}),first=await searchChrome(c,q),visits=first.items[0].metadata?.relatedVisits as any[];
 expect(first.items).toHaveLength(1);expect(visits).toHaveLength(2);expect(first.items[0].metadata?.relatedResource).toMatchObject({kind:"google-drive-folder",url,contentFetched:false});
 for(const v of visits)expect((await readChrome(c,v.ref)).metadata?.url).toBe(url);
 const next=await searchChrome(c,{...q,cursor:first.nextCursor});expect(next.items[0].ref.id).toBe(Buffer.from('[0,"1"]').toString("base64url"));expect(next.nextCursor).toBeUndefined();expect(await readFile(path)).toEqual(before);
 expect(googleDocument("https://drive.google.com.evil.test/drive/folders/fixture_folder_id")).toBeUndefined();expect(googleDocument("https://user:pass@drive.google.com/drive/folders/fixture_folder_id")).toBeUndefined();
});

test("download titles and local opening avoid hashed paths and signed links in the default result",async()=>{
 const root=await folder(),local=join(root,"opaque-export.zip"),c={...defaultConfig(),chromeProfiles:[root]};await writeFile(local,"fixture");
 const db=new Database(join(root,"History"));db.exec("CREATE TABLE downloads(id INTEGER,start_time INTEGER,target_path TEXT);CREATE TABLE downloads_url_chains(id INTEGER,chain_index INTEGER,url TEXT)");db.query("INSERT INTO downloads VALUES(1,13348540800000000,?)").run(local);db.query("INSERT INTO downloads_url_chains VALUES(1,0,?)").run("https://chatgpt.com/backend-api/estuary/content?sig=PRIVATE_TOKEN");db.close();
 const p=await searchChrome(c,querySchema.parse({source:"chrome-downloads",query:""})),r=await readChrome(c,p.items[0].ref);
 expect(p.items[0].title).toBe("ChatGPT data export (ZIP)");expect(p.items[0].metadata?.openLink).toBe(local);expect(JSON.stringify(p)).not.toContain("PRIVATE_TOKEN");expect(p.items[0].excerpt.split(local)).toHaveLength(2);expect(compactRecord(r,true).metadata?.url).toContain("PRIVATE_TOKEN");
 await rm(local);const missing=await readChrome(c,r.ref);
 expect(compactRecord(missing).metadata?.openLink).toBeUndefined();expect(missing.ref).toEqual(r.ref);
});

test("calendar HTML and LinkedIn month dates use the shared projections with exact original fields retained",async()=>{
 expect(readablePim("calendar",{title:"Fixture",notes:"Notes: <b>Community</b><br>Plain &amp; readable"})).toContain("Plain & readable");expect(readablePim("calendar",{notes:"<b>Community</b>"})).not.toContain("<b>");
 const positions=linkedInRecords("Title,Company Name,Started On,Finished On\nEngineer,New Company,Feb 2023,Feb 2024\nEngineer,Old Company,Nov 2021,Feb 2023\n","/fixture.zip","Positions.csv",0);
 expect(positions[1].occurredAt).toBe("2021-11-01T00:00:00.000Z");expect(positions[1].metadata?.datePrecision).toBe("month");expect(positions[1].metadata?.finishedOn).toBe("Feb 2023");expect(positions[1].warnings?.[0]).toContain("sort key");
 const root=await folder(),c={...defaultConfig(),things:join(root,"things"),index:join(root,"index.sqlite"),linkedin:[join(root,"linkedin.zip")],takeout:[join(root,"takeout.zip")]};await mkdir(c.things);await writeFile(join(c.things,"tasks.jsonl"),"");await writeFile(join(c.things,"context.json"),'{"TMTask":[]}');await writeFile(join(c.things,"snapshot-info.json"),'{"taskCount":0,"exportedAt":"2026-01-01T00:00:00Z"}');
 await writeFile(c.linkedin[0],await createZip([{path:"Positions.csv",text:"Title,Company Name,Started On,Finished On\nEngineer,New Company,Feb 2023,Feb 2024\nEngineer,Old Company,Nov 2021,Feb 2023\n"}]));
 await writeFile(c.takeout[0],await createZip([{path:"Takeout/Calendar/Fixture.ics",text:'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20240101T000000Z\r\nSUMMARY:Fixture\r\nDESCRIPTION:Notes <b>community</b><br>readable\r\nEND:VEVENT\r\nEND:VCALENDAR'}]));await rebuildArchive(c);
 const q=querySchema.parse({source:"linkedin-archive",query:"",types:["linkedin-positions"],sort:"oldest"}),p=await searchArchive(c,q);expect(p.items[0].title).toBe("Engineer at Old Company");
 expect((await searchArchive(c,{...q,from:"2021-11-15T00:00:00Z",to:"2021-11-20T00:00:00Z"})).items).toHaveLength(1);
 const event=[...(await exportRecords(c,"takeout-archive")).records.values()][0];expect(event.body.split("Original export record")[0]).not.toContain("<b>");expect(event.body).toContain("<b>");
 const db=new Database(c.index);db.exec("UPDATE meta SET value=json_remove(value,'$.projectionVersion') WHERE key='linkedin-archive'");db.close();await expect(searchArchive(c,q)).rejects.toThrow("explicit source-search rebuild");
});

test("selected mailbox reads skip unrelated MIME parsing while retaining duplicate IDs, original versions and spam opt-in",async()=>{
 const root=await folder(),entry="Takeout/Mail/All mail Including Spam and Trash.mbox",c={...defaultConfig(),things:join(root,"things"),index:join(root,"index.sqlite"),takeout:[join(root,"takeout.zip")]};await mkdir(c.things);await writeFile(join(c.things,"tasks.jsonl"),"");await writeFile(join(c.things,"context.json"),'{"TMTask":[]}');await writeFile(join(c.things,"snapshot-info.json"),'{"taskCount":0,"exportedAt":"2026-01-01T00:00:00Z"}');
 const message=(body:string,label="Inbox")=>`From fixture@example.test Mon Jan 1 00:00:00 2024\nMessage-ID: <duplicate>\nFrom: fixture@example.test\nSubject: Fixture\nX-Gmail-Labels: ${label}\n\n${body}\n`;
 const text=message("first")+message("second","Spam")+message("third");await writeFile(c.takeout[0],await createZip([{path:entry,text,method:8}]));
 const full=await exportRecords(c,"takeout-archive"),selected=await exportRecords(c,"takeout-archive",{part:0,entry,messageIndex:2});expect([...selected.records.values()].map(({observedAt,...r})=>r)).toEqual([...full.records.values()].filter(r=>r.metadata?.originalRecordIndex===2).map(({observedAt,...r})=>r));await rebuildArchive(c);
 const q=querySchema.parse({source:"takeout-archive",query:"",types:["email"]}),p=await searchArchive(c,q),all=await searchArchive(c,{...q,excludeSpamTrash:false});expect(p.items).toHaveLength(2);expect(all.items).toHaveLength(3);
 const spam=all.items.find(r=>r.excerpt.includes("second"))!;expect((await readExport(c,spam.ref)).body).toContain("second");
 await writeFile(c.takeout[0],await createZip([{path:entry,text:text+"From fixture@example.test x\nMalformed unrelated MIME\n"}]));expect((await exportRecords(c,"takeout-archive",{part:0,entry,messageIndex:2})).records.size).toBe(1);await expect(exportRecords(c,"takeout-archive")).rejects.toThrow("boundary");await expect(readExport(c,spam.ref)).rejects.toThrow();
});
