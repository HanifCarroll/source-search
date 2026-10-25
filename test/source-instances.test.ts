import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configSchema,sourceScope} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';

test('another installation supports three named mailboxes and ordinary Markdown in its own timezone',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-instances-'));
 try{
  await writeFile(join(root,'Project plan.md'),'---\ncreated: 2026-07-12\n---\nAn invented project plan.');
  await writeFile(join(root,'README.md'),'Ordinary documentation is searchable too.');
  const c=configSchema.parse({enabledSources:['team','billing','archive-mail','research'],timeZone:'America/New_York',sources:{
   team:{adapter:'gmail',account:'team',email:'team@example.test'},billing:{adapter:'gmail',account:'billing',email:'billing@example.test'},'archive-mail':{adapter:'fastmail',account:'archive',email:'archive@example.test'},
   research:{adapter:'markdown',root,dateFields:['created']}
  }});
  const calls:string[][]=[];
  const runtime=createRuntime(c,async argv=>{
   calls.push(argv);const account=argv[argv.indexOf('--account')+1];
   if(argv.includes('search'))return account==='archive'?{messages:[{message_id:'message',subject:'Fixture',from:'sender@example.test',date:'2026-07-12T12:00:00Z'}],position:0,nextPosition:null,total:1,queryState:'fixture'}:{messages:[{id:'message',subject:'Fixture',from:'sender@example.test',date:'2026-07-12 12:00',snippet:'Fixture text'}]};
   if(account==='archive')return {summary:{message_id:'message',subject:'Fixture',from:'sender@example.test',date:'2026-07-12T12:00:00Z',thread_id:'thread'},body_text:'Mailbox archive'};
   return {headers:{subject:'Fixture',from:'sender@example.test',date:'2026-07-12T12:00:00Z'},message:{id:'message',threadId:'thread'},body:'Mailbox '+account};
  });
  const catalogue=await runtime.list_sources();expect(catalogue.groups['all-mail']).toEqual(['team','billing','archive-mail']);expect(catalogue.groups['all-notes']).toEqual(['research']);
  expect(catalogue.sources.map(s=>s.source)).toEqual(['team','billing','archive-mail','research']);
  const pages=(await runtime.search_sources({queries:[{source:'all-mail',query:'fixture'}]})).results;
  expect(pages.every(p=>p.status==='ok')).toBe(true);expect(pages.map(p=>p.items[0]?.ref.source)).toEqual(['team','billing','archive-mail']);
  const read=await runtime.read_record({ref:pages[1]!.items[0]!.ref});expect(read.record.body).toBe('Mailbox billing');expect(read.record.metadata?.openLink).toContain('billing%40example.test');
  expect((await runtime.read_record({ref:pages[2]!.items[0]!.ref})).record.body).toBe('Mailbox archive');
  const notes=(await runtime.search_sources({queries:[{source:'research',query:'project'}]})).results[0]!;expect(notes.status).toBe('ok');
  const note=await runtime.read_record({ref:notes.items[0]!.ref});expect(note.record.type).toBe('note');expect(note.record.occurredAt).toBe('2026-07-12T04:00:00.000Z');expect(note.record.metadata?.datePrecision).toBe('day');expect(note.record.metadata?.transcription).toBeUndefined();
  const docs=(await runtime.search_sources({queries:[{source:'research',query:'documentation'}]})).results[0]!;expect(docs.items).toHaveLength(1);
  const restricted=createRuntime({...c,enabledSources:['research']},async()=>{throw Error('Disabled accounts must not be accessed');});
  expect((await restricted.search_sources({queries:[{source:'team',query:'x'}]})).results[0]!.error?.code).toBe('SOURCE_DISABLED');
  expect(calls.filter(a=>a.includes('gmail')).every(a=>a.includes('--gmail-no-send'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('source configuration rejects unknown integrations, unsafe IDs, bad zones and group collisions',()=>{
 for(const sources of [{bad:{adapter:'unknown'}},{'../escape':{adapter:'gmail',account:'x',email:'x@example.test'}},{'all-mail':{adapter:'gmail',account:'x',email:'x@example.test'}},{notes:{adapter:'markdown',root:'/fixture',timeZone:'Not/AZone'}}])expect(()=>configSchema.parse({sources})).toThrow();
 expect(()=>configSchema.parse({enabledSources:['missing']})).toThrow('Unknown source');
 const sources={one:{adapter:'gmail',account:'one',email:'one@example.test'}};
 const c=configSchema.parse({sources});expect(sourceScope(c,'one')).not.toBe(sourceScope(configSchema.parse({sources:{one:{...sources.one,adapter:'fastmail'}}}),'one'));
});

test('named database sources keep native reads, pagination and library provenance in their own instance',async()=>{
 const {Database}=await import('bun:sqlite');
 const {syncLibrary}=await import('../src/maintenance/library-sync');
 const {libraryDB}=await import('../src/search/library/store');
 const {searchLibrary,readLibrary}=await import('../src/search/library/index');
 const {querySchema}=await import('../src/domain/contracts');
 const root=await mkdtemp(join(tmpdir(),'ss-database-instances-'));
 try{
  const c=configSchema.parse({enabledSources:['meetings','chat-history','library'],maintenanceEnabled:true,libraryEnabled:true,libraryRoot:join(root,'library'),libraryDatabase:join(root,'qmd.sqlite'),index:join(root,'archives.sqlite'),sources:{meetings:{adapter:'muesli',database:join(root,'meetings.sqlite')},'chat-history':{adapter:'whatsapp',database:join(root,'chat.sqlite')}}});
  const calls=new Database(c.sources.meetings!.adapter==='muesli'?c.sources.meetings.database:'');
  calls.exec("CREATE TABLE meetings(id INTEGER,title TEXT,start_time TEXT,end_time TEXT,raw_transcript TEXT,formatted_notes TEXT,manual_notes TEXT,deleted_at INTEGER);INSERT INTO meetings VALUES(1,'Planning','2026-01-01T00:00:00Z',NULL,'Invented meeting transcript','Summary','Manual',NULL)");calls.close();
  const chat=new Database(join(root,'chat.sqlite'));chat.exec("CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER);INSERT INTO ZWACHATSESSION VALUES(1,'fixture@g.us','Fixture');INSERT INTO ZWAMESSAGE VALUES(1,1,'a',700000000,0,'Invented chat one','fixture',NULL),(2,1,'b',700000001,0,'Invented chat two','fixture',NULL)");chat.close();
  const runtime=createRuntime(c);
  const {duplicateKey}=await import('../src/domain/presentation');
  const meeting=(await runtime.read_record({ref:{source:'meetings',id:'1'}})).record;
  expect(duplicateKey(meeting)).not.toBe(duplicateKey({...meeting,ref:{...meeting.ref,source:'other-meetings'}}));
  const first=(await runtime.search_sources({queries:[{source:'chat-history',query:'invented',limit:1}]})).results[0]!;
  expect(first.items).toHaveLength(1);expect(first.nextCursor).toBeDefined();
  const second=(await runtime.search_sources({queries:[{source:'chat-history',query:'invented',limit:1,cursor:first.nextCursor}]})).results[0]!;
  expect(second.items[0]!.ref).toMatchObject({source:'chat-history',id:'1'});
  const read=await runtime.read_record({ref:first.items[0]!.ref,context:true});expect(read.context).toHaveLength(1);expect((read.context[0] as any).ref.source).toBe('chat-history');
  await syncLibrary(c);
  const manifest=libraryDB(c),rows=manifest.query('SELECT * FROM chunks').all() as any[];manifest.close();
  expect(new Set(rows.map(r=>r.source))).toEqual(new Set(['meetings','chat-history']));
  const db=new Database(c.libraryDatabase);db.exec('CREATE TABLE documents(collection,path,hash,active);CREATE TABLE content_vectors(hash)');
  for(const row of rows){db.query('INSERT INTO documents VALUES(?,?,?,1)').run('ss-'+row.source,row.id+'.md',row.hash);db.query('INSERT INTO content_vectors VALUES(?)').run(row.hash);}db.close();
  const row=rows.find(r=>r.source==='meetings');
  const page=await searchLibrary(c,querySchema.parse({source:'meetings',query:'invented',mode:'lexical'}),async request=>{expect(request.collection).toBe('ss-meetings');return [{file:'qmd://ss-meetings/'+row.id+'.md',score:1,snippet:'Invented meeting'}];});
  expect(page.items).toHaveLength(1);const ref=page.items[0]!.ref;
  const original=await readLibrary(c,ref,async r=>{expect(r.source).toBe('meetings');await runtime.read_record({ref:r});});expect(original.body).toContain('Invented meeting transcript');
  await expect(readLibrary({...c,enabledSources:['library']},ref,async()=>{})).rejects.toThrow('Enable this source');
  const moved=configSchema.parse({...c,sources:{...c.sources,meetings:{adapter:'muesli',database:join(root,'other.sqlite')}}});
  await expect(readLibrary(moved,ref,async()=>{})).rejects.toThrow('configuration');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('named mail cache rejects a provider change even when account strings are identical',async()=>{
 const {syncMail}=await import('../src/maintenance/library-sync');
 const {libraryDB}=await import('../src/search/library/store'),{getMailState:getState}=await import('../src/platform/cache-state');
 const root=await mkdtemp(join(tmpdir(),'ss-mail-instance-'));
 try{
  const c=configSchema.parse({enabledSources:['work'],maintenanceEnabled:true,libraryRoot:root,sources:{work:{adapter:'gmail',account:'same',email:'same@example.test'}}});
  await mkdir(join(root,'mail-raw'),{mode:0o700});
  await syncMail(c,async argv=>argv.includes('search')?{messages:[{id:'one',subject:'Invented message'}]}:{headers:{subject:'Invented message'},message:{id:'one'},body:'Invented body'});
  const next=configSchema.parse({...c,sources:{work:{...c.sources.work,adapter:'fastmail'}}});
  let fetched=false;await syncMail(next,async()=>{fetched=true;throw Error('Must not call the new provider against the old cache');});
  const db=libraryDB(next);expect(getState(db,'work').state).toBe('error');expect(getState(db,'work').error?.message).toContain('provider changed');expect((db.query('SELECT count(*) n FROM mail').get() as any).n).toBe(1);db.close();expect(fetched).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('fresh MCP uses configured note names, date fields, exclusions and DST, and reloads opt-in',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const root=await mkdtemp(join(tmpdir(),'ss-notes-mcp-'));
 const client=new Client({name:'invented-installation',version:'1'});
 try{
  await mkdir(join(root,'node_modules','excluded'),{recursive:true});
  await writeFile(join(root,'node_modules','excluded','hidden.md'),'Invented hidden content');
  await writeFile(join(root,'Winter.md'),'---\ncreated: 2026-01-12 10:30:00\n---\nInvented winter plan');
  await writeFile(join(root,'Summer.md'),'---\ncreated: 2026-07-12\n---\nInvented summer plan');
  await writeFile(join(root,'skip.txt'),'Invented non-Markdown content');
  const c={enabledSources:['journals'],timeZone:'Asia/Tokyo',sources:{journals:{adapter:'markdown',root,timeZone:'America/New_York',dateFields:['created']}}};
  const path=join(root,'settings.json');await writeFile(path,JSON.stringify(c));
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:path},stderr:'pipe'});
  await client.connect(transport);
  const invoke=async(name:string,args={})=>{const r=await client.callTool({name,arguments:args});return JSON.parse((r.content as any[])[0].text);};
  const page=(await invoke('search_sources',{queries:[{source:'journals',query:'invented'}]})).results[0];expect(page.items).toHaveLength(2);
  expect(page.items.map((r:any)=>r.occurredAt).sort()).toEqual(['2026-01-12T15:30:00.000Z','2026-07-12T04:00:00.000Z']);
  expect(page.items.every((r:any)=>r.type==='note')).toBe(true);
  expect((await invoke('read_record',{ref:page.items[0].ref})).record.body).toContain('Invented');
  await writeFile(path,JSON.stringify({...c,enabledSources:[]}));
  expect((await invoke('search_sources',{queries:[{source:'journals',query:'invented'}]})).results[0].error.code).toBe('SOURCE_DISABLED');
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});

test('named Messages preserve references, focus, context and instance-bound continuation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-message-instance-'));
 try{
  const {Database}=await import('bun:sqlite'),database=join(root,'messages.sqlite'),db=new Database(database);
  db.exec(`CREATE TABLE message(guid TEXT,date INTEGER,is_from_me INTEGER,text TEXT,handle_id INTEGER);
    CREATE TABLE chat(guid TEXT);CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);CREATE TABLE handle(id TEXT);
    INSERT INTO handle VALUES('fixture@example.test');INSERT INTO chat VALUES('thread');
    INSERT INTO message VALUES('one',800000000000000000,0,'Invented cobalt first',1),('two',800000000000000001,0,'Invented cobalt second',1);
    INSERT INTO chat_message_join VALUES(1,1),(1,2);`);db.close();
  const config=configSchema.parse({enabledSources:['phone','other'],sources:{phone:{adapter:'messages',database},other:{adapter:'messages',database}}});
  const runtime=createRuntime(config),query={source:'phone',query:'cobalt',limit:1};
  const first=(await runtime.search_sources({queries:[query]})).results[0]!;
  expect(first.items[0]!.ref.source).toBe('phone');expect(first.nextCursor).toBeDefined();
  const read=await runtime.read_record({ref:first.items[0]!.ref,focus:first.items[0]!.focus,context:true});
  expect(read.record.body).toContain('cobalt');expect(read.context).toHaveLength(1);expect((read.context[0] as any).ref.source).toBe('phone');
  const next=(await runtime.search_sources({queries:[{...query,cursor:first.nextCursor}]})).results[0]!;
  expect(next.items[0]!.ref.id).not.toBe(first.items[0]!.ref.id);
  expect((await runtime.search_sources({queries:[{...query,source:'other',cursor:first.nextCursor}]})).results[0]!.error?.code).toBe('INVALID_CURSOR');
 }finally{await rm(root,{recursive:true,force:true});}
});
