import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema,sourceScope} from '../src/platform/config';
import {searchMail,readMail,mailContext,mailStatus} from '../src/sources/mail';
import {readMail as legacyRead} from '../src/sources/mail/legacy';
import {createSourceAccess} from '../src/application/source-access';
import {jmapFixture} from './helpers/jmap';
import {readSecret} from '../src/platform/credentials';
import {connector} from '../src/sources/mail';

async function fixture(fn:(f:ReturnType<typeof jmapFixture>,config:ReturnType<typeof configSchema.parse>)=>Promise<void>){
  const f=jmapFixture();process.env.SOURCE_SEARCH_TEST_TOKEN='invented-token';
  const c=configSchema.parse({enabledSources:['team-mail'],sources:{'team-mail':{adapter:'jmap',account:'team',email:'team@example.test',sessionUrl:f.url,auth:{type:'bearer',token:{env:'SOURCE_SEARCH_TEST_TOKEN'}}}}});
  try{await fn(f,c);}finally{f.stop();delete process.env.SOURCE_SEARCH_TEST_TOKEN;}
}
test('JMAP incrementally applies additions, edits, removals and folder exclusions without relisting',()=>fixture(async(f,c)=>{
  const backend=connector(c,'team-mail')!,initial=await backend.sync();expect(initial.inventory).toHaveLength(7);
  f.state.requests=[];expect((await backend.sync(initial.checkpoint)).messages).toEqual([]);expect(f.state.requests.map(r=>r.method)).toEqual(['Mailbox/get','Email/changes']);
  f.state.emails[0]!.mailboxIds={inbox:false,trash:true} as any;
  f.state.emails[1]!.bodyValues['1'].value='Updated fixture';
  f.state.emails.push({...f.state.emails[1]!,id:'arrival'});f.state.emails=f.state.emails.filter(e=>e.id!=='m2');f.state.version='state2';
  f.state.changes.push({oldState:'state1',newState:'state2',created:['arrival'],updated:['m0','m1'],destroyed:['m2'],hasMoreChanges:false});
  f.state.requests=[];const next=await backend.sync(initial.checkpoint);
  expect(next.messages.map(m=>m.summary.message_id)).toEqual(['arrival','m1']);expect(next.removed.sort()).toEqual(['m0','m2']);
  expect(next.messages[1]!.body_text).toBe('Updated fixture');expect(f.state.requests.some(r=>r.method==='Email/query')).toBe(false);
  expect(f.state.requests.filter(r=>r.method==='Email/get' && r.args.fetchTextBodyValues).flatMap(r=>r.args.ids)).not.toContain('m0');
}));
test('JMAP expired history re-enumerates before pruning and captures the pre-scan email state',()=>fixture(async(f,c)=>{
  const backend=connector(c,'team-mail')!,initial=await backend.sync();f.state.version='expired-next';f.state.requests=[];
  const reset=await backend.sync(initial.checkpoint);expect(reset.inventory).toHaveLength(7);expect(reset.checkpoint).toMatchObject({state:'expired-next'});
  const methods=f.state.requests.map(r=>r.method);expect(methods.indexOf('Email/get')).toBeLessThan(methods.indexOf('Email/query'));
}));
test('JMAP inventories IDs before body downloads and reconciles mailbox activity before completion',()=>fixture(async(f,c)=>{
  const sample=f.state.emails[0]!;
  f.state.emails=Array.from({length:60},(_,i)=>({...sample,id:'fixture'+i,receivedAt:new Date(Date.UTC(2026,0,1+i)).toISOString()}));
  const backend=connector(c,'team-mail')!,first=await backend.sync(),records=new Set(first.messages.map(m=>m.summary.message_id));
  expect(first.hasMore).toBe(true);expect(first.messages).toHaveLength(25);expect(first.inventory).toBeUndefined();
  expect(first.checkpoint).toMatchObject({pending:{offset:25}});expect(Array.isArray((first.checkpoint as any).pending.ids)).toBe(true);
  const trashed=first.messages[0]!.summary.message_id;
  f.state.emails.find(e=>e.id===trashed)!.mailboxIds={inbox:false,trash:true} as any;
  f.state.emails=f.state.emails.filter(e=>e.id!=='fixture30');
  f.state.emails.push({...sample,id:'arrival',receivedAt:'2026-12-01T00:00:00Z'});f.state.version='state2';
  f.state.changes.push({oldState:'state1',newState:'state2',created:['arrival'],updated:[trashed],destroyed:['fixture30'],hasMoreChanges:false});
  let page=first;
  for(let i=0;page.hasMore && i<5;i++){
    page=await backend.sync(page.checkpoint);
    for(const m of page.messages)records.add(m.summary.message_id);
    for(const id of page.removed)records.delete(id);
  }
  expect(page.hasMore).toBe(false);expect(page.checkpoint).toMatchObject({state:'state2'});
  expect([...records].sort()).toEqual(f.state.emails.filter(e=>e.mailboxIds.inbox).map(e=>e.id).sort());
  expect(f.state.requests.filter(r=>r.method==='Email/query')).toHaveLength(1);
  expect(f.state.requests.filter(r=>r.method==='Email/get' && r.args.fetchTextBodyValues).flatMap(r=>r.args.ids)).not.toContain('fixture30');
}));
test('JMAP bounds ID inventory work and rejects changed query pages before fetching bodies',()=>fixture(async(f,c)=>{
  const sample=f.state.emails[0]!;f.state.emails=Array.from({length:30},(_,i)=>({...sample,id:'fixture'+i,receivedAt:new Date(Date.UTC(2026,0,1+i)).toISOString()}));
  f.state.queryPageSize=2;const backend=connector(c,'team-mail')!,first=await backend.sync();
  expect(first.checkpoint).toMatchObject({inventory:{position:16}});expect(first.messages).toEqual([]);expect(first.hasMore).toBe(true);
  f.state.version='state2';await expect(backend.sync(first.checkpoint)).rejects.toMatchObject({code:'STALE_CURSOR'});
  expect(f.state.requests.some(r=>r.method==='Email/get' && r.args.fetchTextBodyValues)).toBe(false);
}));
test('mail maintenance commits checkpoints only after successful bodies and retries publication',()=>fixture(async(f,c)=>{
  const {syncMail}=await import('../src/maintenance/library-sync'),{libraryDB}=await import('../src/search/library/store'),{getMailState:getState,setMailState:setState}=await import('../src/platform/cache-state');
  const {mkdir}=await import('node:fs/promises'),root=await mkdtemp(join(tmpdir(),'ss-jmap-deltas-'));
  try{
    await mkdir(join(root,'mail-raw'),{mode:0o700});c=configSchema.parse({...c,libraryRoot:root,maintenanceEnabled:true,libraryEnabled:true});
    await syncMail(c,undefined,['team-mail']);
    const retry=()=>{const db=libraryDB(c,true);setState(db,'team-mail',{...getState(db,'team-mail'),nextScanAt:0});db.close();};
    const state=()=>{const db=libraryDB(c);try{return getState(db,'team-mail');}finally{db.close();}};
    f.state.version='state2';f.state.changes.push({oldState:'state1',newState:'state2',created:[],updated:['m1'],destroyed:['m0'],hasMoreChanges:false});
    f.state.emails[1]!.bodyValues['1'].value='Changed body';delete (f.state.emails[1] as any).bodyValues['1'];
    retry();await syncMail(c,undefined,['team-mail']);expect(state()).toMatchObject({state:'error',syncCheckpoint:{state:'state1'}});
    let db=libraryDB(c);expect((db.query('SELECT count(*) n FROM mail').get() as any).n).toBe(7);db.close();
    f.state.emails[1]!.bodyValues['1']={value:'Changed body',isTruncated:false};retry();await syncMail(c,undefined,['team-mail']);
    expect(state()).toMatchObject({state:'ready',syncCheckpoint:{state:'state2'},dirty:false});
    db=libraryDB(c);expect((db.query('SELECT count(*) n FROM mail').get() as any).n).toBe(6);expect(JSON.stringify(db.query('SELECT body FROM chunks').all())).toContain('Changed body');db.close();
  }finally{await rm(root,{recursive:true,force:true});}
}));
test('JMAP discovers accounts, respects server batch limits, orders results and paginates with changing page sizes',()=>fixture(async(f,c)=>{
  const first=await searchMail({source:'team-mail',query:'',limit:5},undefined,undefined,c);
  expect(first.items.map(i=>i.ref.id)).toEqual(['m6','m5','m4','m3','m2']);expect(first.totalMatches).toBe(7);
  const second=await searchMail({source:'team-mail',query:'',limit:1,cursor:first.nextCursor},undefined,undefined,c);
  expect(second.items[0]!.ref.id).toBe('m1');
  const third=await searchMail({source:'team-mail',query:'',limit:3,cursor:second.nextCursor},undefined,undefined,c);
  expect(third.items.map(i=>i.ref.id)).toEqual(['m0']);expect(third.nextCursor).toBeUndefined();
  expect(f.state.requests.filter(r=>r.method==='Email/get').every(r=>r.args.ids.length<=3)).toBe(true);
  expect(f.state.auth.every(a=>a==='Bearer invented-token')).toBe(true);
  const other=configSchema.parse({...c,sources:{...c.sources,'second-mail':{...c.sources['team-mail'],accountId:'two'}},enabledSources:['team-mail','second-mail']});
  await searchMail({source:'second-mail',query:'',limit:1},undefined,undefined,other);
  expect(f.state.requests.at(-1).args.accountId).toBe('two');
}));
test('JMAP preserves legacy body formatting and saved record versions',()=>fixture(async(f,c)=>{
  c=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],recordFormat:'mailbridge-v1'}}});
  let raw:any;const record=await readMail('team-mail','m2',undefined,c,value=>{raw=value;});
  const old=configSchema.parse({...c,sources:{'team-mail':{adapter:'fastmail',account:'team',email:'team@example.test'}}});
  const before=await legacyRead('team-mail','m2',async()=>raw,old);
  expect(record.ref.version).toBe(before.ref.version);
  expect(record.body).toBe('Body 2');
  const context=await mailContext(record,undefined,c);
  expect(context.records).toHaveLength(6);
  expect(f.state.requests.every(r=>['Mailbox/get','Email/query','Email/get','Thread/get'].includes(r.method))).toBe(true);
}));
test('JMAP rejects stale pagination and account changes',()=>fixture(async(f,c)=>{
  const first=await searchMail({source:'team-mail',query:'',limit:1},undefined,undefined,c);
  f.state.version='state2';
  await expect(searchMail({source:'team-mail',query:'',limit:1,cursor:first.nextCursor},undefined,undefined,c)).rejects.toMatchObject({code:'STALE_CURSOR'});
  const other=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],accountId:'two'}}});
  expect(sourceScope(c,'team-mail')).not.toBe(sourceScope(other,'team-mail'));
  await expect(searchMail({source:'team-mail',query:'',limit:1,cursor:first.nextCursor},undefined,undefined,other)).rejects.toMatchObject({code:'STALE_CURSOR'});
}));
test('JMAP sends exact UTC dates, escaped phrase syntax and intersected folder restrictions',()=>fixture(async(f,c)=>{
  await searchMail({source:'team-mail',query:'Bob\'s "draft" \\ plan',match:'phrase',from:'2026-10-02T09:00:00-03:00',to:'2026-10-06T12:00:00Z',folders:['Inbox'],limit:5},undefined,undefined,c);
  const filter=f.state.requests.find(r=>r.method==='Email/query').args.filter;
  expect(filter.conditions[0].text).toBe('"Bob\\\'s \\"draft\\" \\\\ plan"');
  expect(JSON.stringify(filter)).toContain('2026-10-02T12:00:00.000Z');
  const restricted=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],folders:['Sent']}}});
  expect((await searchMail({source:'team-mail',query:'',folders:['Inbox'],limit:5},undefined,undefined,restricted)).items).toHaveLength(0);
  await expect(readMail('team-mail','m1',undefined,restricted)).rejects.toMatchObject({code:'SOURCE_RESTRICTED'});
  await expect(searchMail({source:'team-mail',query:'',folders:['Typo'],limit:1},undefined,undefined,c)).rejects.toMatchObject({code:'UNKNOWN_FOLDER'});
}));
test('JMAP reports real errors instead of empty results',()=>fixture(async(f,c)=>{
  f.state.status=401;await expect(mailStatus(c,'team-mail')).rejects.toMatchObject({code:'AUTHENTICATION_FAILED'});
  f.state.status=429;await expect(mailStatus(c,'team-mail')).rejects.toMatchObject({code:'RATE_LIMITED'});
  f.state.status=200;f.state.methodError='unsupportedFilter';await expect(searchMail({source:'team-mail',query:'',limit:1},undefined,undefined,c)).rejects.toMatchObject({code:'UNSUPPORTED_FILTER'});
  f.state.methodError='';f.state.wrongAccount=true;await expect(readMail('team-mail','m1',undefined,c)).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
  f.state.wrongAccount=false;f.state.missing=true;await expect(readMail('team-mail','m1',undefined,c)).rejects.toMatchObject({code:'NOT_FOUND'});
}));
test('JMAP requires an unambiguous account, enforces timeouts and respects disabled sources',()=>fixture(async(f,c)=>{
  f.state.primary='';await expect(mailStatus(c,'team-mail')).rejects.toMatchObject({code:'SOURCE_NOT_CONFIGURED'});
  f.state.primary='one';f.state.delay=300;
  const short=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],timeoutMs:100}}});
  await expect(mailStatus(short,'team-mail')).rejects.toMatchObject({code:'TIMEOUT'});
  f.state.auth=[];
  const disabled=configSchema.parse({...c,enabledSources:[]});
  expect(()=>createSourceAccess(disabled).searchSession()({source:'team-mail',query:'',limit:1})).toThrow('Enable this source');
  expect(f.state.auth).toHaveLength(0);
}));
test('private credential files and shell-free refresh commands produce single bounded values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'source-search-credentials-'));
  try{
    await writeFile(join(dir,'token'),'invented-file-token\n',{mode:0o600});
    expect(await readSecret({file:join(dir,'token')})).toBe('invented-file-token');
    expect(await readSecret({command:[process.execPath,'-e','process.stdout.write("invented-command-token")']})).toBe('invented-command-token');
    await expect(readSecret({command:[process.execPath,'-e','process.stderr.write("secret-error"); process.exit(1)']})).rejects.toMatchObject({code:'CREDENTIAL_UNAVAILABLE'});
    await expect(readSecret({command:[process.execPath,'-e','process.stdout.write("x".repeat(70000))']})).rejects.toMatchObject({code:'CREDENTIAL_UNAVAILABLE'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('generic JMAP retains all body parts and reports truncation',()=>fixture(async(f,c)=>{
  const e=f.state.emails[0]!;
  e.textBody.push({partId:'2'});(e.bodyValues as any)['2']={value:'Second body section',isTruncated:true};
  const record=await readMail('team-mail','m0',undefined,c);
  expect(record.body).toBe('Body 0\n\nSecond body section');expect(record.warnings?.join(' ')).toContain('truncated');
  const legacy=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],recordFormat:'mailbridge-v1'}}});
  expect((await readMail('team-mail','m0',undefined,legacy)).body).toBe('Body 0');
}));
test('JMAP Basic authentication and bounded response parsing work independently of Fastmail',()=>fixture(async(f,c)=>{
  const basic=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],sessionUrl:new URL('/.well-known/jmap',f.url).href,auth:{type:'basic',username:'other-user',password:{env:'SOURCE_SEARCH_TEST_TOKEN'}}}}});
  await mailStatus(basic,'team-mail');expect(f.state.auth[0]).toBe('Basic '+Buffer.from('other-user:invented-token').toString('base64'));
  f.state.emails[0]!.bodyValues['1'].value='x'.repeat(9*1024*1024);
  await expect(readMail('team-mail','m0',undefined,c)).rejects.toMatchObject({code:'OUTPUT_LIMIT'});
}));
test('native JMAP library sync captures raw records, preserves references and rejects a different account scope',()=>fixture(async(f,c)=>{
  const {syncMail}=await import('../src/maintenance/library-sync');
  const {libraryDB}=await import('../src/search/library/store'),{getMailState:getState}=await import('../src/platform/cache-state');
  const {mkdir,readFile}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'source-search-native-cache-'));
  try{
    await mkdir(join(root,'mail-raw'),{mode:0o700});
    c=configSchema.parse({...c,libraryRoot:root,maintenanceEnabled:true,libraryEnabled:true});
    await syncMail(c,undefined,['team-mail']);
    const db=libraryDB(c);expect(getState(db,'team-mail').state).toBe('ready');
    const records=db.query('SELECT data FROM mail WHERE source=?').all('team-mail') as {data:string}[];expect(records).toHaveLength(7);db.close();
    const raw=JSON.parse(await readFile(join(root,'mail-raw','team-mail-m0.json'),'utf8'));expect(raw.raw.summary.message_id).toBe('m0');expect(raw.raw.body_text).toBe('Body 0');
    const fresh=await readMail('team-mail','m0',undefined,c);expect(raw.ref).toEqual(fresh.ref);
    const before=f.state.requests.length;
    const switched=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],accountId:'two'}}});
    await syncMail(switched,undefined,['team-mail']);expect(f.state.requests).toHaveLength(before);
    const after=libraryDB(c);expect(getState(after,'team-mail').state).toBe('error');expect((after.query('SELECT count(*) AS n FROM mail').get() as any).n).toBe(7);after.close();
  }finally{await rm(root,{recursive:true,force:true});}
}));

test('native attachment maintenance downloads JMAP blobs, excludes books and validates parent and folder scope',()=>fixture(async(f,c)=>{
 const {downloadAttachments}=await import('../src/maintenance/mail-attachments');
 const {connector}=await import('../src/sources/mail');
 const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'ss-attachment-'));
 try{
  c=configSchema.parse({...c,libraryRoot:root,maintenanceEnabled:true,enabledSources:['team-mail','documents']});
  f.state.emails[0]!.attachments.push({name:'book.epub',type:'application/epub+zip',blobId:'book',size:50});
  const record=await readMail('team-mail','m0',undefined,c),input={source:'team-mail',id:'m0',version:record.ref.version,scope:sourceScope(c,'team-mail')};
  const files=await downloadAttachments(c,input);expect(files.entries).toHaveLength(1);expect((await readFile(files.entries[0]!.path)).toString()).toBe('invented file');expect(f.state.downloads).toHaveLength(1);
  await expect(downloadAttachments(c,{...input,scope:'old-account'})).rejects.toMatchObject({code:'STALE_RECORD'});
  await expect(downloadAttachments(c,{...input,version:'old-version'})).rejects.toMatchObject({code:'STALE_RECORD'});
  const restricted=configSchema.parse({...c,sources:{'team-mail':{...c.sources['team-mail'],folders:['Sent']}}});
  await expect(connector(restricted,'team-mail')!.download('m0','blob',100)).rejects.toMatchObject({code:'SOURCE_RESTRICTED'});
  await expect(connector(c,'team-mail')!.download('m0','blob',5)).rejects.toMatchObject({code:'OUTPUT_LIMIT'});
  f.state.blob='short';await expect(connector(c,'team-mail')!.download('m0','blob',100)).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
  expect(f.state.requests.every(r=>['Email/get','Mailbox/get'].includes(r.method))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
}));

test('document pipeline uses its selected native-mail config and reuses verified attachment extraction',()=>fixture(async(f,c)=>{
 const {mkdir,readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'ss-native-documents-'));
 try{
  c=configSchema.parse({...c,maintenanceEnabled:true,libraryRoot:root,enabledSources:['team-mail','documents']});
  f.state.emails[0]!.attachments=[{name:'agenda.txt',type:'text/plain',blobId:'blob',size:13}];
  let raw:any;const record=await readMail('team-mail','m0',undefined,c,data=>raw=data);
  await mkdir(join(root,'mail-raw'),{mode:0o700});await writeFile(join(root,'mail-raw/one.json'),JSON.stringify({source:'team-mail',id:'m0',ref:record.ref,raw,accountSignature:sourceScope(c,'team-mail')}));
  const path=join(root,'config.json');await writeFile(path,JSON.stringify(c));
  for(let i=0;i<2;i++){
   const child=Bun.spawn([Bun.which('python3')||'python3',join(import.meta.dir,'../scripts/extract-documents.py'),'--config',path],{env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:'/deliberately/not/this/config'},stdout:'pipe',stderr:'pipe'});
   const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,err).toBe(0);expect(JSON.parse(out)).toMatchObject({documents:1,failures:0});
  }
  const result=JSON.parse(await readFile(join(root,'documents.json'),'utf8'));expect(result.records[0].body).toBe('invented file');expect(result.records[0].metadata.mailRef).toEqual(record.ref);expect(f.state.downloads).toHaveLength(1);
 }finally{await rm(root,{recursive:true,force:true});}
}));
