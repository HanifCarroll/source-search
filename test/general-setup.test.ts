import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {configSchema,sourceConfig} from '../src/platform/config';
import {createSourceAccess} from '../src/application/source-access';
import {createRuntime} from '../src/application/runtime';
import {indexSources} from '../src/maintenance/search-index';
import {rebuildConfiguredArchives} from '../src/maintenance/archives';
import {runSdk,disposeSearchWorkers} from '../src/search/qmd/runner';
afterEach(disposeSearchWorkers);
import {readQmd,qmdPath} from '../src/search/qmd/vault';
import {saveSettings,mcpConfig,doctor} from '../src/interfaces/setup';
import {querySchema} from '../src/domain/contracts';
import {hash} from '../src/domain/identity';
import {publish} from '../src/search/library/store';

async function temporary(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'ss-general-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('public QMD SDK indexes and reads literal names, retains old normalized references and limits collections',()=>temporary(async dir=>{
 const notes=join(dir,'Research Notes');await mkdir(notes);const body='# Cobalt\n\nThe invented cobalt telescope is ready.';await writeFile(join(notes,'A Thought.md'),body);
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['research'],sources:{research:{adapter:'vault',roots:{notes},database:join(dir,'research.sqlite')}}});
 expect((await indexSources(c,[]))[0]!.update).toMatchObject({indexed:1});
 const access=createSourceAccess(c),page=await access.searchSession()(querySchema.parse({source:'research',query:'cobalt',mode:'lexical'}));
 expect(page.status).toBe('ok');expect(page.items).toHaveLength(1);expect(page.items[0]!.ref.source).toBe('research');
 expect((await access.read(page.items[0]!.ref)).record.body).toBe(body);
 const scoped=sourceConfig(c,'research'),legacy={source:'vault',id:'qmd://notes/'+qmdPath('A Thought.md'),version:hash(body)};
 expect((await readQmd(scoped,legacy)).body).toBe(body);
 expect(await runSdk(scoped,{index:'vault',mode:'lexical',query:'--option "quoted" $(literal)'})).toEqual([]);
 await expect(indexSources({...c,maintenanceEnabled:false},[])).rejects.toMatchObject({code:'MAINTENANCE_DISABLED'});
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const path=join(dir,'config.json');await writeFile(path,JSON.stringify(c));const client=new Client({name:'sdk-installation-fixture',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:path},stderr:'pipe'}));
  const response=await client.callTool({name:'search_sources',arguments:{queries:[{source:'research',query:'cobalt',mode:'lexical'}]}});
  const data=JSON.parse((response.content as any[])[0].text);expect(data.results[0].status).toBe('ok');expect(data.results[0].items[0].ref.source).toBe('research');
 }finally{await client.close();}

}));

test('library keyword index runs with no vault, global QMD executable or models',()=>temporary(async dir=>{
 const c=configSchema.parse({maintenanceEnabled:true,libraryEnabled:true,enabledSources:['library','work'],libraryRoot:join(dir,'library'),libraryDatabase:join(dir,'library.sqlite'),sources:{work:{adapter:'imap',account:'work',email:'work@example.test',username:'work@example.test',host:'imap.example.test',auth:{type:'password',password:{env:'UNUSED_TEST_SECRET'}}}}});
 await publish(c,'work',[{ref:{source:'work',id:'invented',version:'v1'},title:'Cobalt project',body:'Cobalt project notes',type:'email',observedAt:'2026-01-01T00:00:00Z',locator:'source-search://work/invented'}],{mail:'work'});
 expect((await indexSources(c,['--library','--update-only']))[0]!.update).toMatchObject({indexed:1});
 expect(await runSdk(c,{index:'library',mode:'lexical',query:'cobalt',collection:'ss-work'})).toHaveLength(1);
}));

test('workers reopen a replaced index and keyword search survives a missing optional ranker',()=>temporary(async dir=>{
 const notes=join(dir,'notes');await mkdir(notes);await writeFile(join(notes,'one.md'),'# Cobalt\n\nInvented cobalt observation.');
 const c=configSchema.parse({maintenanceEnabled:true,qmdRoots:{notes},qmdDatabase:join(dir,'old.sqlite'),searchRanker:{engine:'onnx',python:'/missing/python',directory:join(dir,'missing-model')}});
 await runSdk(c,{index:'vault',action:'update'});
 expect(await runSdk(c,{index:'vault',mode:'lexical',query:'cobalt'})).toHaveLength(1);
 await writeFile(join(notes,'one.md'),'# Amber\n\nInvented amber observation.');
 const replacement={...c,qmdDatabase:join(dir,'new.sqlite')};
 await runSdk(replacement,{index:'vault',action:'update'});
 // An index installer must checkpoint before replacement; copying only the
 // main file of an active WAL database is not a valid SQLite backup.
 for(const path of [c.qmdDatabase,replacement.qmdDatabase]){const db=new Database(path);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();}
 await rename(replacement.qmdDatabase,c.qmdDatabase);
 expect(await runSdk(c,{index:'vault',mode:'lexical',query:'amber'})).toHaveLength(1);
 expect(await runSdk(c,{index:'vault',mode:'lexical',query:'cobalt'})).toHaveLength(0);
}));

test('stable browser profile IDs survive reorder and keep legacy numeric references',()=>temporary(async dir=>{
 const first=join(dir,'First'),second=join(dir,'Second');await mkdir(first);await mkdir(second);
 for(const [path,name] of [[first,'Alpha'],[second,'Beta']])await writeFile(join(path!,'Bookmarks'),JSON.stringify({roots:{bar:{type:'folder',children:[{id:'42',type:'url',name,url:'https://example.test/'+name,date_added:'13300000000000000'}]}}}));
 const old=configSchema.parse({enabledSources:['chrome-bookmarks'],chromeProfiles:[first,second]});
 const legacy=(await createSourceAccess(old).searchSession()(querySchema.parse({source:'chrome-bookmarks',query:'Alpha'}))).items[0]!.ref;
 const make=(profiles:any[])=>configSchema.parse({enabledSources:['chrome-bookmarks','other-browser'],sources:{'chrome-bookmarks':{adapter:'chrome-bookmarks',profiles,legacyProfileIds:['first','second']},'other-browser':{adapter:'chrome-bookmarks',profiles:[{id:'second',path:second}]}}});
 const legacySecond=(await createSourceAccess(old).searchSession()(querySchema.parse({source:'chrome-bookmarks',query:'Beta'}))).items[0]!.ref;
 expect((await createSourceAccess(make([{id:'second',path:second}])).read(legacySecond)).record.title).toBe('Beta');
 const c=make([{id:'first',path:first},{id:'second',path:second}]),a=createSourceAccess(c);
 const ref=(await a.searchSession()(querySchema.parse({source:'chrome-bookmarks',query:'Alpha'}))).items[0]!.ref;
 const reordered=createSourceAccess(make([{id:'second',path:second},{id:'first',path:first}]));
 expect((await reordered.read(ref)).record.title).toBe('Alpha');expect((await reordered.read(legacy)).record.title).toBe('Alpha');
 expect((await reordered.searchSession()(querySchema.parse({source:'other-browser',query:'Beta'}))).items[0]!.ref.source).toBe('other-browser');
 await expect(reordered.read({...ref,source:'other-browser'})).rejects.toThrow();
}));

test('Things SQLite exports preserve tasks, projects, checklist, tags and archive isolation',()=>temporary(async dir=>{
 const database=join(dir,'main.sqlite'),db=new Database(database);
 db.exec(`CREATE TABLE TMTask(uuid TEXT,title TEXT,notes TEXT,type INTEGER,status INTEGER,creationDate REAL,project TEXT,area TEXT,trashed INTEGER);
 CREATE TABLE TMArea(uuid TEXT,title TEXT);CREATE TABLE TMTag(uuid TEXT,title TEXT);CREATE TABLE TMTaskTag(tasks TEXT,tags TEXT);CREATE TABLE TMChecklistItem(task TEXT,title TEXT,status INTEGER,"index" INTEGER);
 INSERT INTO TMArea VALUES('area','Invented work');INSERT INTO TMTask VALUES('project','Observatory','Project notes',1,0,1767225600,NULL,'area',0),('task','Cobalt lens','Order a lens',0,3,1767225600,'project',NULL,0);
 INSERT INTO TMTag VALUES('tag','Optics');INSERT INTO TMTaskTag VALUES('task','tag');INSERT INTO TMChecklistItem VALUES('task','Compare lenses',3,0);`);db.close();
 const original=await readFile(database);
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['tasks'],index:join(dir,'archives.sqlite'),sources:{tasks:{adapter:'things-archive',database}}});
 await rebuildConfiguredArchives(c);
 const access=createSourceAccess(c),page=await access.searchSession()(querySchema.parse({source:'tasks',query:'cobalt'}));expect(page.items).toHaveLength(1);
 const r=(await access.read(page.items[0]!.ref)).record;expect(r.ref.source).toBe('tasks');expect(r.body).toContain('Optics');expect(r.body).toContain('[x] Compare lenses');expect(r.body).toContain('Observatory');expect(r.body).toContain('Invented work');
 const runtime=createRuntime(c),focused=(await runtime.search_sources({queries:[{source:'tasks',query:'Compare'}]})).results[0]!.items[0]!;expect(focused.focus).toBeDefined();expect((await runtime.read_record({ref:focused.ref,focus:focused.focus})).record.body).toContain('Compare lenses');
 expect(await readFile(database)).toEqual(original);
}));

test('portable calendars expand recurring events across DST and contacts need no native helper',()=>temporary(async dir=>{
 const calendar=join(dir,'calendar.ics'),contacts=join(dir,'contacts.vcf');
 await writeFile(calendar,['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:meeting','DTSTART;TZID=America/New_York:20260307T090000','DTEND;TZID=America/New_York:20260307T100000','RRULE:FREQ=DAILY;COUNT=3','SUMMARY:Invented planning','END:VEVENT','BEGIN:VEVENT','UID:meeting','RECURRENCE-ID;TZID=America/New_York:20260308T090000','DTSTART;TZID=America/New_York:20260308T110000','DTEND;TZID=America/New_York:20260308T120000','SUMMARY:Moved planning','END:VEVENT','END:VCALENDAR'].join('\r\n'));
 await writeFile(contacts,'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:alice\r\nFN:Alice Example\r\nEMAIL:alice@example.test\r\nTEL:+12025550123\r\nEND:VCARD\r\n');
 const c=configSchema.parse({timeZone:'Asia/Tokyo',enabledSources:['schedule','people'],sources:{schedule:{adapter:'ical',paths:[calendar]},people:{adapter:'vcard',paths:[contacts]}}}),a=createSourceAccess(c);
 const page=await a.searchSession()(querySchema.parse({source:'schedule',query:'planning',from:'2026-03-07T00:00:00Z',to:'2026-03-10T00:00:00Z',sort:'oldest'}));
 expect(page.items.map(r=>r.occurredAt)).toEqual(['2026-03-07T14:00:00.000Z','2026-03-08T15:00:00.000Z','2026-03-09T13:00:00.000Z']);
 expect((await a.read(page.items[1]!.ref)).record.title).toBe('Moved planning');
 const person=(await a.searchSession()(querySchema.parse({source:'people',query:'alice'}))).items[0]!;expect((await a.read(person.ref)).record.body).toContain('+12025550123');
 await expect(a.searchSession()(querySchema.parse({source:'schedule',query:'planning'}))).rejects.toMatchObject({code:'REQUIRED_FILTER'});
}));

test('two Things instances keep separate library freshness and original references',()=>temporary(async dir=>{
 const first=join(dir,'first.sqlite'),second=join(dir,'second.sqlite');
 for(const [path,title] of [[first,'Cobalt'],[second,'Violet']]){const db=new Database(path!);db.exec('CREATE TABLE TMTask(uuid TEXT,title TEXT,notes TEXT,type INTEGER,status INTEGER,creationDate REAL)');db.query('INSERT INTO TMTask VALUES(?,?,?,?,?,?)').run('task',title!,'Invented task',0,0,1767225600);db.close();}
 const c=configSchema.parse({maintenanceEnabled:true,libraryEnabled:true,enabledSources:['library','things-archive','other-tasks'],index:join(dir,'archives.sqlite'),libraryRoot:join(dir,'library'),libraryDatabase:join(dir,'library.sqlite'),sources:{'things-archive':{adapter:'things-archive',database:first},'other-tasks':{adapter:'things-archive',database:second}}});
 await indexSources(c,['--library']);const a=createSourceAccess(c),query=querySchema.parse({source:'library',query:'violet',mode:'lexical'});
 const ref=(await a.searchSession()(query)).items[0]!.ref;
 expect((await a.read(ref)).record.body).toContain('Violet');
 let db=new Database(first);db.exec("UPDATE TMTask SET title='Cobalt revised'");db.close();
 expect((await a.read(ref)).record.body).toContain('Violet');
 db=new Database(second);db.exec("UPDATE TMTask SET title='Violet revised'");db.close();
 await expect(a.read(ref)).rejects.toMatchObject({code:'STALE_RECORD'});
 await indexSources(c,['--library']);const fresh=(await a.searchSession()(query)).items[0]!.ref;
 expect((await a.read(fresh)).record.body).toContain('Violet revised');
}));

test('setup preserves existing settings, generates portable MCP configuration, and diagnoses only chosen sources',()=>temporary(async dir=>{
 const path=join(dir,'private/config.json'),notes=join(dir,'Notes');await mkdir(notes);await writeFile(join(notes,'Welcome.md'),'An invented welcome note');
 const raw={timeZone:'Europe/Berlin',enabledSources:['notes'],sources:{notes:{adapter:'markdown',root:notes,content:'journal',dateFromFilename:true}}};
 await saveSettings(raw,path);const saved=await saveSettings({...raw,timeZone:'Asia/Tokyo'},path);expect(JSON.parse(await readFile(saved.backup!,'utf8'))).toEqual(raw);expect((await stat(path)).mode&0o077).toBe(0);
 const c=configSchema.parse(raw),mcp=mcpConfig(c,path);expect(mcp.mcpServers['source-search'].env.SOURCE_SEARCH_CONFIG_FILE).toBe(path);
 const result=await doctor(c);expect(result.checks).toEqual([]);expect(result.sources.sources[0]!.available).toBe(true);
 const child=Bun.spawn([process.execPath,'src/cli.ts','setup','--notes',notes],{cwd:join(import.meta.dir,'..'),env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:path},stdin:'ignore',stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(0);expect(JSON.parse(await readFile(path,'utf8')).timeZone).toBe('Asia/Tokyo');
 expect(JSON.parse(await readFile(path,'utf8')).sources).toEqual(raw.sources);
 const before=await readFile(path,'utf8'),conflict=Bun.spawn([process.execPath,'src/cli.ts','setup','--notes',join(dir,'Different')],{cwd:join(import.meta.dir,'..'),env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:path},stdin:'ignore',stdout:'pipe',stderr:'pipe'});expect(await conflict.exited).toBe(1);expect(await readFile(path,'utf8')).toBe(before);
}));
