import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema,evidenceScope,type Config} from '../src/platform/config';
import {cacheDB,getState,setState} from '../src/platform/cache-db';
import {recordStore} from '../src/platform/record-store';
import {createRuntime} from '../src/application/runtime';
import {syncSources} from '../src/maintenance/sources';
import {syncDirect,directReader} from '../src/maintenance/direct';
import {publishMail} from '../src/maintenance/library-sync';
import {jmapFixture} from './helpers/jmap';

async function temp(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-direct-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const config=(root:string,more:object)=>configSchema.parse({memoryRoot:join(root,'memory'),libraryRoot:join(root,'cache'),index:join(root,'archives.sqlite'),maintenanceEnabled:true,...more});
const feed=(c:Config,cursor?:string)=>createRuntime(c).list_changes({feed:'sources',sources:c.enabledSources,cursor,limit:100}) as Promise<any>;
async function sync(c:Config){const result=await syncSources(c);expect(result.sources.filter(s=>!s.ok)).toEqual([]);return result;}
const inventory=(c:Config,source:string)=>recordStore(join(c.libraryRoot,'records.sqlite')).observation(source,evidenceScope(c,source));

test('direct Markdown changes work without library models, skip unchanged reads, and retain failed inventories',()=>temp(async root=>{
 const folder=join(root,'notes');await mkdir(folder);await writeFile(join(folder,'a.md'),'Invented alpha');await writeFile(join(folder,'b.md'),'Invented beta');
 const c=config(root,{enabledSources:['work-notes'],sources:{'work-notes':{adapter:'markdown',root:folder}}});
 await sync(c);const first=await feed(c);expect(first.items.map((e:any)=>e.kind)).toEqual(['reset']);
 const before=(await inventory(c,'work-notes'))!.entries;await sync(c);expect((await feed(c,first.cursor)).items).toEqual([]);
 expect((await inventory(c,'work-notes'))!.entries).toEqual(before);
 await writeFile(join(folder,'a.md'),'Revised alpha');await rm(join(folder,'b.md'));await writeFile(join(folder,'c.md'),'Invented gamma');
 await sync(c);const next=await feed(c,first.cursor);expect(next.items.map((e:any)=>[e.kind,e.ref.id])).toEqual([['updated','a.md'],['added','c.md'],['removed','b.md']]);
 for(const e of next.items.filter((e:any)=>e.kind!=='removed'))expect((await createRuntime(c).read_record({ref:e.ref})).record.ref).toEqual(e.ref);
 await writeFile(join(folder,'a.md'),'x'.repeat(3*1024*1024));expect((await syncSources(c)).ok).toBe(false);
 expect((await feed(c,next.cursor)).items).toEqual([]);expect((await feed(c,next.cursor)).coverage[0].lastError).toBeDefined();
 expect((await inventory(c,'work-notes'))!.entries).toHaveLength(2);
 const moved=join(root,'other-notes');await mkdir(moved);await writeFile(join(moved,'new.md'),'New selection');
 const other=config(root,{...c,sources:{'work-notes':{adapter:'markdown',root:moved}}});await sync(other);
 await expect(feed(other,next.cursor)).rejects.toMatchObject({code:'INVALID_CURSOR'});expect((await feed(other)).items.map((e:any)=>e.kind)).toEqual(['reset']);
}));

test('Messages inventories include textless rows, edits, joined metadata changes and confirmed deletions',()=>temp(async root=>{
 const path=join(root,'messages.sqlite');let db=new Database(path);
 db.exec(`CREATE TABLE message(guid TEXT,date INTEGER,is_from_me INTEGER,service TEXT,text TEXT,attributedBody BLOB,handle_id INTEGER,item_type INTEGER);
 CREATE TABLE chat(guid TEXT);CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);CREATE TABLE handle(id TEXT);
 INSERT INTO handle VALUES('alex@example.test');INSERT INTO chat VALUES('chat');
 INSERT INTO message VALUES('a',800000000000000000,0,'iMessage','Invented hello',NULL,1,0),('empty',800000000000000001,0,'iMessage',NULL,NULL,1,0);
 INSERT INTO chat_message_join VALUES(1,1),(1,2);`);db.close();
 const c=config(root,{enabledSources:['phone'],sources:{phone:{adapter:'messages',database:path}}});await sync(c);
 const first=await feed(c);expect((await inventory(c,'phone'))!.entries).toHaveLength(2);
 await sync(c);expect((await feed(c,first.cursor)).items).toEqual([]);
 db=new Database(path);db.exec("UPDATE handle SET id='blair@example.test';DELETE FROM message WHERE guid='empty';INSERT INTO message VALUES('c',800000000000000002,1,'iMessage','New arrival',NULL,1,0)");db.close();
 await sync(c);const page=await feed(c,first.cursor);expect(page.items.map((e:any)=>[e.kind,e.ref.id])).toEqual([['updated','a'],['added','c'],['removed','empty']]);
 expect((await createRuntime(c).read_record({ref:page.items[0].ref})).record.author).toBe('blair@example.test');
 db=new Database(path);db.exec('DROP TABLE chat');db.close();expect((await syncSources(c)).ok).toBe(false);expect((await feed(c,page.cursor)).items).toEqual([]);
}));

test('JMAP source changes reuse provider deltas, survive failures, and publish deferred library text',()=>temp(async root=>{
 const f=jmapFixture();process.env.SOURCE_SEARCH_CHANGE_TEST_TOKEN='invented-token';
 try{
  const c=config(root,{enabledSources:['inbox'],sources:{inbox:{adapter:'jmap',account:'work',email:'work@example.test',sessionUrl:f.url,auth:{type:'bearer',token:{env:'SOURCE_SEARCH_CHANGE_TEST_TOKEN'}}}}});
  const due=()=>{const db=cacheDB(c,true);setState(db,'inbox',{...getState(db,'inbox'),nextScanAt:0});db.close();};
  await sync(c);const first=await feed(c);expect((await inventory(c,'inbox'))!.entries).toHaveLength(7);
  f.state.requests=[];due();await sync(c);expect((await feed(c,first.cursor)).items).toEqual([]);expect(f.state.requests.map(r=>r.method)).toEqual(['Mailbox/get','Email/changes']);
  f.state.emails[1]!.bodyValues['1'].value='Invented revised content';f.state.emails.push({...f.state.emails[1]!,id:'arrival'});f.state.emails=f.state.emails.filter(e=>e.id!=='m0');f.state.version='state2';
  f.state.changes.push({oldState:'state1',newState:'state2',created:['arrival'],updated:['m1'],destroyed:['m0'],hasMoreChanges:false});
  due();await sync(c);const next=await feed(c,first.cursor);expect(next.items.map((e:any)=>[e.kind,e.ref.id])).toEqual([['added','arrival'],['updated','m1'],['removed','m0']]);
  for(const e of next.items.filter((e:any)=>e.kind!=='removed'))expect((await createRuntime(c).read_record({ref:e.ref})).record.ref).toEqual(e.ref);
  const db=cacheDB(c);expect(db.query('SELECT count(*) n FROM chunks').get()).toEqual({n:0});db.close();
  await publishMail({...c,libraryEnabled:true,enabledSources:[...c.enabledSources,'library']});const published=cacheDB(c);expect(getState(published,'inbox').dirty).toBe(false);expect(JSON.stringify(published.query('SELECT body FROM chunks').all())).toContain('Invented revised content');published.close();
  f.state.methodError='serverFail';due();expect((await syncSources(c)).ok).toBe(false);
  expect((await feed(c,next.cursor)).items).toEqual([]);expect((await inventory(c,'inbox'))!.entries).toHaveLength(7);
 }finally{f.stop();delete process.env.SOURCE_SEARCH_CHANGE_TEST_TOKEN;}
}));

test('Chromium inventories every visit without search deduplication and track download metadata',()=>temp(async root=>{
 const profile=join(root,'profile');await mkdir(profile);const path=join(profile,'History');let db=new Database(path);
 db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY,title TEXT,url TEXT);CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER);
 CREATE TABLE downloads(id INTEGER PRIMARY KEY,target_path TEXT,start_time INTEGER);CREATE TABLE downloads_url_chains(id INTEGER,chain_index INTEGER,url TEXT);
 INSERT INTO urls VALUES(1,'Invented doc','https://docs.google.com/document/d/invented/edit');INSERT INTO visits VALUES(1,1,13411699200000000),(2,1,13411699300000000);
 INSERT INTO downloads VALUES(1,'/invented/file.pdf',13411699200000000);INSERT INTO downloads_url_chains VALUES(1,0,'https://example.test/file.pdf');`);db.close();
 const c=config(root,{enabledSources:['visits','downloads'],sources:{visits:{adapter:'browser-history',profiles:[{id:'research',path:profile}]},downloads:{adapter:'browser-downloads',profiles:[{id:'research',path:profile}]}}});
 await sync(c);expect((await inventory(c,'visits'))!.entries).toHaveLength(2);expect((await inventory(c,'downloads'))!.entries).toHaveLength(1);const first=await feed(c);
 db=new Database(path);db.exec("DELETE FROM visits WHERE id=1;UPDATE urls SET title='Revised doc';UPDATE downloads SET target_path='/invented/revised.pdf'");db.close();await sync(c);
 const events=(await feed(c,first.cursor)).items;expect(events.map((e:any)=>e.kind).sort()).toEqual(['removed','updated','updated']);
 for(const e of events.filter((e:any)=>e.kind!=='removed'))expect((await createRuntime(c).read_record({ref:e.ref})).record.ref).toEqual(e.ref);
}));

test('native PIM requires a complete scan and calendar window changes produce a reset',()=>temp(async root=>{
 const helper=join(root,'pim.ts'),data=join(root,'pim.json');
 await writeFile(helper,`for(const row of await Bun.file(${JSON.stringify(data)}).json())console.log(JSON.stringify(row));`);
 const event={type:'calendar_event',id:'e1',title:'Invented review',start:new Date().toISOString(),end:new Date(Date.now()+3600000).toISOString(),calendar:{identifier:'work'}};
 const write=async(rows:object[],complete=true)=>writeFile(data,JSON.stringify([...rows,{type:'scan_finished',source:'calendar',scanned:rows.length,complete}]));
 const c=config(root,{enabledSources:['agenda'],sources:{agenda:{adapter:'calendar',helper,launcher:process.execPath}}});
 await write([event]);await sync(c);const first=await feed(c);const ref=(await inventory(c,'agenda'))!.entries[0]!.ref;
 expect((await createRuntime(c).read_record({ref})).record.title).toBe(event.title);
 await write([],false);expect((await syncSources(c)).ok).toBe(false);expect((await feed(c,first.cursor)).items).toEqual([]);
 await write([{...event,title:'Revised review'}]);await sync(c);const changed=await feed(c,first.cursor);expect(changed.items.map((e:any)=>e.kind)).toEqual(['updated']);
 await sync({...c,changeTracking:{calendarPastDays:30,calendarFutureDays:60}});expect((await feed(c,changed.cursor)).items.map((e:any)=>e.kind)).toEqual(['reset']);
}));

test('portable contact files track exact references and QMD observes only selected active documents',()=>temp(async root=>{
 const cards=join(root,'people.vcf'),path=join(root,'vault.sqlite');const card=(name:string)=>`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:${name}\r\nEND:VCARD\r\n`;await writeFile(cards,card('Invented Alex'));
 const db=new Database(path);db.exec("CREATE TABLE documents(collection TEXT,path TEXT,hash TEXT,active INTEGER);INSERT INTO documents VALUES('selected','a.md','old-hash',1),('private','secret.md','secret-hash',1),('selected','removed.md','inactive',0)");db.close();
 const c=config(root,{enabledSources:['people','notes-index'],sources:{people:{adapter:'vcard',paths:[cards]},'notes-index':{adapter:'vault',roots:{selected:root},database:path}}});
 await sync(c);expect((await inventory(c,'notes-index'))!.entries.map(e=>e.ref.id)).toEqual(['qmd://selected/a.md']);const first=await feed(c);
 await writeFile(cards,card('Revised Alex'));const changed=new Database(path);changed.exec("UPDATE documents SET hash='new-hash' WHERE path='a.md'");changed.close();await sync(c);
 expect((await feed(c,first.cursor)).items.map((e:any)=>e.kind)).toEqual(['updated','updated']);
 const person=(await inventory(c,'people'))!.entries[0]!.ref;expect((await createRuntime(c).read_record({ref:person})).record.body).toContain('Revised Alex');
}));

test('index-level trackers emit resets only for changed content and isolate failed readers',()=>temp(async root=>{
 const c=config(root,{enabledSources:['history','notes'],sources:{history:{adapter:'agent-history'},notes:{adapter:'markdown',root}}});
 let revision='one';const reader:typeof directReader=(_c,source)=>async()=>{if(source==='notes')throw Error('Invented unavailable source');return {entries:[],state:{checkedAt:new Date().toISOString(),strategy:'index',coverage:'Fixture committed index',generation:revision,granularity:'index'}};};
 expect((await syncDirect(c,c.enabledSources,reader)).ok).toBe(false);const first=await feed(c);expect(first.items).toHaveLength(1);
 await syncDirect(c,c.enabledSources,reader);expect((await feed(c,first.cursor)).items).toEqual([]);
 revision='two';await syncDirect(c,c.enabledSources,reader);expect((await feed(c,first.cursor)).items.map((e:any)=>e.kind)).toEqual(['reset']);
}));

test('file hydration/replacement retries a changing read and never saves its earlier stamp',()=>temp(async root=>{
 const {stableRead}=await import('../src/maintenance/direct/model'),path=join(root,'hydrating.md');await writeFile(path,'Before');let reads=0;
 const result=await stableRead(path,async()=>{const value=await readFile(path,'utf8');if(++reads===1)await writeFile(path,'After hydration');return value;});
 expect(reads).toBe(2);expect(result.value).toBe('After hydration');
 await expect(stableRead(path,async()=>{await writeFile(path,'Keeps changing '+ ++reads);return 'unstable';})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
}));

test('selected Things archives refresh without the library and preserve other archive instances',()=>temp(async root=>{
 const first=join(root,'first.sqlite'),second=join(root,'second.sqlite');
 for(const path of [first,second]){const db=new Database(path);db.exec("CREATE TABLE TMTask(uuid TEXT,title TEXT,notes TEXT,type INTEGER,status INTEGER,creationDate REAL);INSERT INTO TMTask VALUES('a','Invented task','Initial notes',0,0,1767225600)");db.close();}
 const c=config(root,{enabledSources:['things-archive','other-tasks'],sources:{'things-archive':{adapter:'things-archive',database:first},'other-tasks':{adapter:'things-archive',database:second}}});
 await sync(c);const before=await feed(c);const changed=new Database(second);changed.exec("UPDATE TMTask SET title='Revised task'");changed.close();await sync(c);
 const next=await feed(c,before.cursor);expect(next.items.map((e:any)=>[e.source,e.kind])).toEqual([['other-tasks','updated']]);
 expect((await createRuntime(c).read_record({ref:next.items[0].ref})).record.title).toBe('Revised task');
}));

test('Firefox and Safari inventory readers track visits and bookmarks using their existing original references',()=>temp(async root=>{
 const {build}=await import('plist'),fox=join(root,'firefox'),safari=join(root,'safari');await mkdir(fox);await mkdir(safari);
 let db=new Database(join(fox,'places.sqlite'));db.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY,title TEXT,url TEXT);CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,place_id INTEGER,visit_date INTEGER);CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,guid TEXT,type INTEGER,fk INTEGER,parent INTEGER,title TEXT,dateAdded INTEGER);
 INSERT INTO moz_places VALUES(1,'Invented observatory','https://example.test');INSERT INTO moz_historyvisits VALUES(1,1,1767225600000000);INSERT INTO moz_bookmarks VALUES(1,'folder',2,NULL,0,'Research',NULL),(2,'saved',1,1,1,'Invented bookmark',1767225600000000);`);db.close();
 db=new Database(join(safari,'History.db'));db.exec("CREATE TABLE history_items(id INTEGER PRIMARY KEY,url TEXT);CREATE TABLE history_visits(id INTEGER PRIMARY KEY,history_item INTEGER,visit_time REAL,title TEXT);INSERT INTO history_items VALUES(1,'https://example.test');INSERT INTO history_visits VALUES(1,1,788918400,'Invented visit')");db.close();
 const leaf={WebBookmarkType:'WebBookmarkTypeLeaf',WebBookmarkUUID:'saved',URLString:'https://example.test',URIDictionary:{title:'Invented bookmark'}};await writeFile(join(safari,'Bookmarks.plist'),build({Children:[leaf]}));
 const c=config(root,{enabledSources:['fox-visits','fox-saved','safari-visits','safari-saved'],sources:{'fox-visits':{adapter:'firefox-history',profiles:[{id:'work',path:fox}]},'fox-saved':{adapter:'firefox-bookmarks',profiles:[{id:'work',path:fox}]},'safari-visits':{adapter:'safari-history',profiles:[{id:'home',path:safari}]},'safari-saved':{adapter:'safari-bookmarks',profiles:[{id:'home',path:safari}]}}});
 await sync(c);const first=await feed(c);for(const source of c.enabledSources)for(const e of (await inventory(c,source))!.entries)expect((await createRuntime(c).read_record({ref:e.ref})).record.ref).toEqual(e.ref);
 db=new Database(join(fox,'places.sqlite'));db.exec("UPDATE moz_places SET title='Revised visit';DELETE FROM moz_bookmarks WHERE type=1");db.close();db=new Database(join(safari,'History.db'));db.exec('DELETE FROM history_visits');db.close();await writeFile(join(safari,'Bookmarks.plist'),build({Children:[{...leaf,URIDictionary:{title:'Revised bookmark'}}]}));await sync(c);
 expect((await feed(c,first.cursor)).items.map((e:any)=>e.kind)).toEqual(['updated','removed','removed','updated']);
}));
