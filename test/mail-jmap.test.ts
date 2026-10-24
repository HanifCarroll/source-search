import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema,sourceScope} from '../src/platform/config';
import {searchMail,readMail,mailContext,mailStatus} from '../src/sources/mail';
import {readMail as legacyRead} from '../src/sources/mail/legacy';
import {createSourceAccess} from '../src/application/source-access';
import {jmapFixture} from './helpers/jmap';
import {readSecret} from '../src/sources/mail/credentials';

async function fixture(fn:(f:ReturnType<typeof jmapFixture>,config:ReturnType<typeof configSchema.parse>)=>Promise<void>){
  const f=jmapFixture();process.env.SOURCE_SEARCH_TEST_TOKEN='invented-token';
  const c=configSchema.parse({enabledSources:['team-mail'],sources:{'team-mail':{adapter:'jmap',account:'team',email:'team@example.test',sessionUrl:f.url,auth:{type:'bearer',token:{env:'SOURCE_SEARCH_TEST_TOKEN'}}}}});
  try{await fn(f,c);}finally{f.stop();delete process.env.SOURCE_SEARCH_TEST_TOKEN;}
}
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
  const {libraryDB,getState}=await import('../src/search/library/store');
  const {mkdir,readFile}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'source-search-native-cache-'));
  try{
    await mkdir(join(root,'mail-raw'));
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
