import {test,expect,afterEach} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {defaultConfig} from "./helpers/config";
import {createRuntime,boundedMap} from "../src/application/runtime";
import {decodeAttributedBody} from "../src/sources/messages/reader";
import {typedMessage} from "./helpers/messages";
import { querySchema, type RecordData } from "../src/domain/contracts";
import { hit, textPage, packetBytes } from "../src/domain/results";
import {findRecordMatch,contentSections} from "../src/domain/content";
import {cassStatus,searchCass} from "../src/sources/agent-history/index";
import {annotateDuplicates,compactRecord,googleDocument} from "../src/domain/presentation";
import {writePreview} from "../src/application/preview";
import {rebuildArchive,searchArchive} from "../src/sources/archives/index";
import {searchMail} from "./helpers/mail";
import {scanRecords} from "../src/domain/scan";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
const roots:string[]=[];
async function folder(){const root=await mkdtemp(join(tmpdir(),"source-search-repairs-"));roots.push(root);return root;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});
function record(body:string,source:RecordData['ref']['source']='calls'):RecordData{return {ref:{source,id:'fixture'},body,title:'Fixture title',type:source==='calls'?'call-transcript':'message',locator:'source-search://fixture',observedAt:'',metadata:{fixture:true}};}

test('length-delimited Messages decoding retains punctuation, whitespace and emoji; malformed formats fail closed',()=>{
 for(const text of ['+: Literal prefix 🦊\nSecond line','a'.repeat(4000)+' café 👋'])expect(decodeAttributedBody(typedMessage(text)).text).toBe(text);
 const cut=typedMessage('NSParagraphStyle is legitimate message text').subarray(0,-3);
 expect(decodeAttributedBody(cut).status).toBe('undecodable');
 expect(decodeAttributedBody(Buffer.from('streamtyped\u0000not a real archive')).status).toBe('undecodable');
 expect(decodeAttributedBody(Buffer.from('bplist00NSAttributedString')).status).toBe('undecodable');
});

test('WhatsApp native participants are separate from group identity, and unknown is explicit',async()=>{
 const root=await folder(),c={...defaultConfig(),whatsapp:join(root,'wa.db')},db=new Database(c.whatsapp);
 db.exec('CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER,ZGROUPMEMBER INTEGER);CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER,ZMEMBERJID TEXT,ZCONTACTNAME TEXT)');
 db.exec("INSERT INTO ZWACHATSESSION VALUES(1,'group@g.us','Fixture Group');INSERT INTO ZWAGROUPMEMBER VALUES(2,'speaker@lid','Alex');INSERT INTO ZWAMESSAGE VALUES(1,1,'m1',700000000,0,'fixture content','group@g.us',NULL,2);INSERT INTO ZWAMESSAGE VALUES(2,1,'m2',700000001,0,'fixture content','group@g.us',NULL,NULL)");db.close();
 const p=(await createRuntime(c).search_sources({queries:[{source:'whatsapp',query:'fixture'}]})).results[0];
 expect(p.items.map(h=>h.author)).toEqual(['unknown sender','Alex']);expect(p.items[1].metadata?.senderId).toBe('speaker@lid');
 const r=await createRuntime(c).read_record({ref:p.items[1].ref});expect(r.record.author).toBe('Alex');expect(r.record.conversation).toBe('group@g.us');
});

test('CASS reconciles nested stale quick health with full readiness, but never bypasses active maintenance',async()=>{
 let active=false;let origin='local';let line:number|null=1;const calls:string[][]=[];
 const runner=async(r:any)=>{calls.push(r.args);const data=r.args.includes('health')?{healthy:false,initialized:true,status:active?'rebuilding':'unhealthy',errors:['index stale'],state:{index:{exists:true,stale:true,status:'ready'},database:{exists:true,opened:true},rebuild:{active}}}:r.args.includes('status')?{healthy:true,status:'healthy',index:{exists:true,fresh:true},database:{exists:true,opened:true},rebuild:{active:false}}:{hits:[{title:'Fixture',snippet:'fixture',source_path:'/synthetic/session',line_number:line,agent:'codex',source_id:'fixture-import',origin_kind:origin}],total_matches:1,_meta:{next_cursor:null}};return {exitCode:0,stdout:JSON.stringify(data),stderr:'',timedOut:false,outputLimitExceeded:false};};
 const c=defaultConfig();expect((await cassStatus(c,runner)).available).toBe(true);
 expect((await searchCass(c,querySchema.parse({source:'agent-history',query:'fixture'}),runner)).items).toHaveLength(1);
 expect(calls.filter(c=>c.includes('search')).every(c=>c.includes('--no-maintenance')&&c.includes('--no-daemon'))).toBe(true);
 origin='remote';await expect(searchCass(c,querySchema.parse({source:'agent-history',query:'fixture'}),runner)).rejects.toThrow('non-local');origin='local';
 line=null;const p=await searchCass(c,querySchema.parse({source:'agent-history',query:'fixture'}),runner);const {readCass}=await import('../src/sources/agent-history/index');await expect(readCass(c,p.items[0].ref,false,runner)).rejects.toThrow('canonical message');line=1;
 active=true;await expect(searchCass(c,querySchema.parse({source:'agent-history',query:'fixture'}),runner)).rejects.toThrow('rebuilding');
 expect(calls.some(c=>c.includes('index'))).toBe(false);
});

test('matches identify the section, name-only hits and exact Unicode positions; focus binds the original',()=>{
 const r=record('Original transcript\n'+'a'.repeat(15000)+'\nİstanbul café needle\n\nGenerated meeting notes\nsummarytoken\n\nManual notes\nmanualtoken');
 const q=querySchema.parse({source:'calls',query:'needle'}),h=hit(r,q,1);expect(h.match.section).toBe('primary');
 const focused=textPage(r,undefined,h.focus);expect(focused.body).toContain('needle');expect(focused.page.offset).toBeGreaterThan(0);expect(focused.metadata).toBeDefined();
 expect(()=>textPage({...r,body:r.body+'changed'},undefined,h.focus)).toThrow('Focus');
 expect(()=>textPage(r,textPage(r).nextCursor,h.focus)).toThrow('Choose');
 expect(findRecordMatch(r,{query:'summarytoken'})?.section).toBe('generated');expect(findRecordMatch(r,{query:'summarytoken',sections:['primary']})).toBeUndefined();
 expect(findRecordMatch({...r,body:'',title:'Spanish Teacher'},{query:'Spanish'})?.field).toBe('title');
 const uni=record('İstanbul and needle');const match=findRecordMatch(uni,{query:'needle'})!;expect(uni.body.slice(match.start,match.end)).toBe('needle');
 const note=record('---\nbackend: metadatatoken\n---\n## Review Notes\nreviewtoken\n\n## Transcript\nprimarytoken','voice-journals');expect(findRecordMatch(note,{query:'metadatatoken'})).toBeUndefined();expect(findRecordMatch(note,{query:'reviewtoken'})?.section).toBe('review');expect(findRecordMatch(note,{query:'primarytoken'})?.section).toBe('primary');
 const email={...record('My own words\n\nOn yesterday Alex wrote:\n> quotedtoken','mail-personal'),type:'email'};expect(findRecordMatch(email,{query:'quotedtoken'})?.section).toBe('quoted');
 expect(contentSections(note).every(s=>s.start>=0 && s.end<=note.body.length)).toBe(true);
 expect(findRecordMatch(note,{query:'metadatatoken',sections:['metadata']})?.section).toBe('metadata');
 const phrase=record('Spanish alone then Spanish language');const located=findRecordMatch(phrase,{query:'Spanish language',match:'phrase'})!;expect(located.start).toBe(19);expect(phrase.body.slice(located.start,located.end)).toBe('Spanish language');
 const raw=record('Readable text\n\nOriginal export record\nmetadatatoken','takeout-archive');const meta=hit(raw,querySchema.parse({source:'takeout-archive',query:'metadatatoken',sections:['metadata']}),1);expect(meta.match.section).toBe('metadata');expect(meta.focus).toBeUndefined();expect(meta.match.explanation).toContain('details:true');
});

test('archive section filtering, exact focus and legacy format guidance preserve all originals',async()=>{
 const root=await folder(),c={...defaultConfig(),things:join(root,'things'),chatgpt:[join(root,'chat')],index:join(root,'index.sqlite')};await mkdir(c.things);await mkdir(c.chatgpt[0]!);
 await writeFile(join(c.things,'tasks.jsonl'),'');await writeFile(join(c.things,'context.json'),'{"TMTask":[]}');await writeFile(join(c.things,'snapshot-info.json'),'{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}');
 const text='---\nfixture: metadatatoken\n---\n'+'a'.repeat(12000)+' needle phrase\nmarker';await writeFile(join(c.chatgpt[0]!,'conversations.json'),JSON.stringify([{id:'conv',title:'Fixture',current_node:'n',mapping:{root:{id:'root',parent:null,children:['n'],message:null},n:{id:'n',parent:'root',children:[],message:{id:'m',author:{role:'user'},create_time:1704067200,content:{content_type:'text',parts:[text]}}}}}]));
 await rebuildArchive(c);const rt=createRuntime(c),p=(await rt.search_sources({queries:[{source:'chatgpt-archive',query:'needle',sections:['primary']}]})).results[0];expect(p.items).toHaveLength(1);
 const read=await rt.read_record({ref:p.items[0].ref,focus:p.items[0].focus});expect(read.record.body).toContain('needle');expect(read.record.page.offset).toBeGreaterThan(0);
 const metadata=(await rt.search_sources({queries:[{source:'chatgpt-archive',query:'metadatatoken',sections:['metadata']}]})).results[0];expect(metadata.items).toHaveLength(1);expect(metadata.items[0].match.section).toBe('metadata');
 const phrase=(await rt.search_sources({queries:[{source:'chatgpt-archive',query:'phrase marker',match:'phrase'}]})).results[0];expect(phrase.items).toHaveLength(0);expect(phrase.scan?.checked).toBe(1);expect(phrase.scan?.exhausted).toBe(true);expect(phrase.totalMatches).toBe(0);
 const db=new Database(c.index);db.exec("UPDATE meta SET value='1' WHERE key='formatVersion'");db.close();
 await expect(searchArchive(c,querySchema.parse({source:'chatgpt-archive',query:'needle',sections:['primary']}))).rejects.toThrow('explicit');expect((await searchArchive(c,querySchema.parse({source:'chatgpt-archive',query:'needle'}))).items).toHaveLength(1);
});

test('mail previews hydrate only three hits, keep continuation and report Date basis separately from direction',async()=>{
 let reads=0;const source='mail-personal';const p=await searchMail(querySchema.parse({source,query:'needle',limit:5}),async args=>{
  if(args.includes('get')){reads++;const id=args[args.indexOf('get')+1];return {message:{id,internalDate:'1704067200000',threadId:'thread',labelIds:['SENT']},headers:{subject:'Fixture',date:'Mon, 1 Jan 2024 00:00:00 +0000'},body:'needle original'};}
  return {messages:Array.from({length:5},(_,i)=>({id:'m'+i,subject:'Fixture',date:'2024-01-01T00:00:00Z'})),nextPageToken:'later'};
 });
 expect(reads).toBe(3);expect(p.items[0].excerpt).toContain('needle');expect(p.items[0].metadata?.dateKind).toBe('message-date-header');expect(p.items[0].metadata?.direction).toBe('outgoing');expect(p.items[4].match.field).toBe('provider');expect(p.items[4].focus).toBeUndefined();expect(p.nextCursor).toBeDefined();
 expect(compactRecord({...record('text',source),type:'email'}).metadata?.dateKind).not.toBe('sent');
});

test('bounded parallel work preserves order and empty candidate pages expose unfinished work',async()=>{
 let current=0,peak=0;const out=await boundedMap([0,1,2,3,4,5],async n=>{peak=Math.max(peak,++current);await Bun.sleep(5);current--;return n;},2);expect(out).toEqual([0,1,2,3,4,5]);expect(peak).toBe(2);
 const db=new Database(':memory:');db.exec('CREATE TABLE rows(id INTEGER,time INTEGER)');db.transaction(()=>{for(let i=1;i<=5001;i++)db.query('INSERT INTO rows VALUES(?,?)').run(i,i);})();
 const q=querySchema.parse({source:'messages',query:'needle',sort:'oldest'}),convert=(r:any)=>({...record(r.id===5001?'needle':'other','messages'),ref:{source:'messages' as const,id:String(r.id)}});
 const first=scanRecords(db,'SELECT id,time FROM rows',[],[],'time','id',q,convert);expect(first.items).toHaveLength(0);expect(first.scan?.checked).toBe(5000);expect(first.scan?.exhausted).toBe(false);
 const last=scanRecords(db,'SELECT id,time FROM rows',[],[],'time','id',{...q,cursor:first.nextCursor},convert);expect(last.items[0].ref.id).toBe('5001');expect(last.scan?.exhausted).toBe(true);db.close();
});

test('grouped Gmail requests share the three-original preview budget and Fastmail dates use receivedAt',async()=>{
 let reads=0;
 const run=async(args:string[])=>{if(args.includes('get')){reads++;return {message:{id:args[args.indexOf('get')+1],internalDate:'1704067200000'},headers:{subject:'Fixture'},body:'needle original'};}return {messages:Array.from({length:5},(_,i)=>({id:'m'+i,subject:'Fixture'}))};};
 const result=await createRuntime(defaultConfig(),run).search_sources({queries:[{source:'mail-personal',query:'needle',limit:5},{source:'mail-consulting',query:'needle',limit:5}]});expect(reads).toBe(3);expect(result.results.every(p=>p.items.length===5)).toBe(true);
 const rt=createRuntime(defaultConfig(),async()=>({summary:{message_id:'fixture',date:'2024-01-01T01:00:00+01:00',folders:[{role:'sent'}]},body_text:'fixture'}));
 const r=await rt.read_record({ref:{source:'mail-fastmail',id:'fixture'}});expect(r.record.metadata?.dateKind).toBe('provider-received-at');expect(r.record.metadata?.direction).toBe('outgoing');expect(r.record.occurredAt).toBe('2024-01-01T00:00:00.000Z');
});

test('full-catalogue grouped search retains matching sources and every mail hit after budget reductions',async()=>{
 const root=await folder(),c={...defaultConfig(),journals:root,voiceNotes:root,callNotes:root,things:join(root,'missing'),messages:join(root,'missing-messages'),whatsapp:join(root,'missing-wa'),muesli:join(root,'missing-calls'),chromeProfiles:[root],pimLauncher:join(root,'missing-helper'),cassBinary:join(root,'missing-cass')};
 await writeFile(join(root,'2024-01-01.md'),'fixture journal');
 const all=Array.from({length:30},(_,i)=>({id:'m'+i,subject:'Fixture '+i+'x'.repeat(250),from:'x'.repeat(500),snippet:'fixture '+'x'.repeat(500)}));
 const run=async(argv:string[])=>{if(argv.includes('get'))throw Error('unused');if(argv.includes('--paged'))return {position:0,queryState:'stable',total:0,nextPosition:null,messages:[]};const n=Number(argv[argv.indexOf('--max')+1]),p=argv.indexOf('--page'),start=p>=0?Number(argv[p+1]):0;return {messages:all.slice(start,start+n),nextPageToken:start+n<all.length?String(start+n):undefined};};
 const rt=createRuntime(c,run),{sourceIds}=await import('./helpers/config');const result=await rt.search_sources({queries:sourceIds.map(source=>({source,query:'fixture',limit:25,...(source==='calendar'?{from:'2024-01-01T00:00:00Z',to:'2025-01-01T00:00:00Z'}:{})}))});
 expect(result.results).toHaveLength(sourceIds.length);expect(packetBytes(result)).toBeLessThan(48*1024);expect(result.results.find(r=>r.source==='journals')?.items).toHaveLength(1);
 for(const source of ['mail-personal','mail-consulting'] as const){let page=result.results.find(r=>r.source===source)!;const ids:string[]=[];do{ids.push(...page.items.map(i=>i.ref.id));if(!page.nextCursor)break;page=(await rt.search_sources({queries:[{source,query:'fixture',limit:25,cursor:page.nextCursor}]})).results[0];}while(true);expect(ids).toEqual(all.map(i=>i.id));}
});

test('duplicates preserve original references; document handoff validates exact provider URLs',()=>{
 const a={...record('x'),metadata:{}},b={...record('y','call-notes'),metadata:{sourceLocator:'Muesli meetings.id=fixture; start_time=x'}};
 a.ref.id='31';b.metadata.sourceLocator='Muesli meetings.id=31; start_time=x';annotateDuplicates([a,b]);expect((a.metadata as any).duplicateEvidence[0].reason).toContain('related representations');
 const doc='https://docs.google.com/document/d/fixture_document_identifier/edit';expect(googleDocument(doc+'#heading=one')?.url).toBe(doc);expect(googleDocument('https://docs.google.com.evil.test/document/d/fixture_document_identifier/edit')).toBeUndefined();expect(googleDocument('https://user@docs.google.com/document/d/fixture_document_identifier/edit')).toBeUndefined();expect(googleDocument('http://docs.google.com/document/d/fixture_document_identifier/edit')).toBeUndefined();
});

test('explicit previews are private bounded text windows, and symlink roots are rejected',async()=>{
 const root=await folder(),privateRoot=join(root,'previews'),r=textPage(record('fixture <script> literal source'));const p=await writePreview(r,privateRoot);expect((await stat(p.path)).mode&0o777).toBe(0o600);expect(await readFile(p.path,'utf8')).toContain('fixture <script> literal source');expect(p.scope).toContain('window');
 const linked=join(root,'linked');await symlink(privateRoot,linked);await expect(writePreview(r,linked)).rejects.toThrow('ordinary');
});

test('multi-year Calendar windows retain overlapping occurrences once and bind their continuation',async()=>{
 const root=await folder(),script=join(root,'helper.ts'),launcher=join(root,'launcher'),c={...defaultConfig(),pimLauncher:launcher,pimHelper:join(root,'identity')};
 const events=[{id:'span',start:'2024-01-01T00:00:00Z',end:'2024-01-03T00:00:00Z'},{id:'leap',start:'2024-02-29T23:00:00-03:00',end:'2024-03-01T00:00:00-03:00'},{id:'late',start:'2025-12-31T23:00:00Z',end:'2026-01-01T01:00:00Z'}].map(e=>({...e,title:'fixture',type:'calendar_event',calendar:{identifier:'cal'}}));
 await writeFile(script,`const a=process.argv;const from=Date.parse(a[a.indexOf('--from')+1]),to=Date.parse(a[a.indexOf('--to')+1]);const data=${JSON.stringify(events)}.filter(e=>Date.parse(e.start)<to && Date.parse(e.end)>from);for(const r of data)console.log(JSON.stringify(r));console.log(JSON.stringify({type:'scan_finished',source:'calendar',complete:true,scanned:data.length}));`);
 await writeFile(launcher,`#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);await chmod(launcher,0o700);
 const rt=createRuntime(c);
 for(const sort of ['oldest','newest'] as const){let cursor:string|undefined;const seen:string[]=[];let pages=0;do{const p=(await rt.search_sources({queries:[{source:'calendar',query:'fixture',from:'2023-01-01T00:00:00Z',to:'2026-02-01T00:00:00Z',sort,limit:1,cursor}]})).results[0];expect(p.status).toBe('ok');seen.push(...p.items.map(h=>JSON.parse(Buffer.from(h.ref.id,'base64url').toString())[0]));cursor=p.nextCursor;pages++;expect(pages).toBeLessThan(12);}while(cursor);expect(new Set(seen).size).toBe(3);expect(seen).toHaveLength(3);}
});

test('fresh MCP exposes focus and previews and uses the same shared focused reader',async()=>{
 const root=await folder(),config=join(root,'config.json');await writeFile(join(root,'2024-01-01.md'),'a'.repeat(14000)+' needle');await writeFile(config,JSON.stringify({journals:root,enabledSources:["journals"]}));
 const client=new Client({name:'repairs-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['src/mcp.ts'],cwd:process.cwd(),env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:config} as Record<string,string>,stderr:'pipe'});await client.connect(transport);
 try{const definitions=await client.listTools();const schema=definitions.tools.find(t=>t.name==='read_record')!.inputSchema;expect((schema.properties as any).focus).toBeDefined();const search=JSON.parse(((await client.callTool({name:'search_sources',arguments:{queries:[{source:'journals',query:'needle'}]}})) as any).content[0].text as string);const h=search.results[0].items[0];const read=JSON.parse(((await client.callTool({name:'read_record',arguments:{ref:h.ref,focus:h.focus}})) as any).content[0].text as string);expect(read.record.body).toContain('needle');expect(read.record.page.offset).toBeGreaterThan(0);}finally{await client.close();}
});
