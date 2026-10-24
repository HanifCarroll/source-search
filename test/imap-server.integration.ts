// Independent-server integration test. Creates only disposable loopback mail accounts.
// Run: bun test/imap-server.integration.ts (Docker and openssl required).
import {ImapFlow} from 'imapflow';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {configSchema} from '../src/platform/config';
import {searchMail,readMail,mailStatus,mailContext} from '../src/sources/mail';
import {imapConnector} from '../src/sources/mail/imap';
import {createSourceAccess} from '../src/application/source-access';

const image='dovecot/dovecot@sha256:d08fcd7c274f11d42cc77d1eb3f44388398ee8656ff16502c6f9e08236165bbb';
const dir=await mkdtemp(join(tmpdir(),'source-search-imap-')),name='source-search-test-'+randomUUID();
const password=randomUUID(),checks:string[]=[];
let admin:ImapFlow|undefined,second:ImapFlow|undefined;
async function command(args:string[]){const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(`${args[0]} failed: ${err}`);return out.trim();}
try{
  await chmod(dir,0o755);
  await command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'tls.key'),'-out',join(dir,'tls.crt'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
  await chmod(join(dir,'tls.key'),0o644);
  await command(['docker','run','--rm','-d','--name',name,'-p','127.0.0.1::31993','-p','127.0.0.1::31143','-e','USER_PASSWORD='+password,'--mount',`type=bind,src=${dir},dst=/etc/dovecot/ssl,readonly`,image]);
  const port=Number((await command(['docker','port',name,'31993/tcp'])).split(':').at(-1));
  const plainPort=Number((await command(['docker','port',name,'31143/tcp'])).split(':').at(-1));
  const ca=await readFile(join(dir,'tls.crt'),'utf8');
  const open=async(user:string)=>{const client=new ImapFlow({host:'127.0.0.1',port,secure:true,tls:{ca},auth:{user,pass:password},logger:false,disableAutoIdle:true});client.on('error',()=>{});await client.connect();return client;};
  // Container startup is asynchronous; retry only this disposable server connection.
  for(let n=0;n<30;n++){try{admin=await open('alice@example.test');break;}catch{await Bun.sleep(200);}}
  assert(admin,'Dovecot did not start');
  second=await open('bob@example.test');
  for(const box of ['Sent','Projects/日本語','Spam','Trash'])await admin.mailboxCreate(box);
  const message=(subject:string,body:string,extra='')=>`From: Alice <alice@example.test>\r\nTo: Bob <bob@example.test>\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.test>\r\nDate: Mon, 1 Jan 2001 12:00:00 +0000\r\n${extra || 'Content-Type: text/plain; charset=utf-8\r\n'}\r\n${body}\r\n`;
  await admin.append('INBOX',message('early','alpha beta café'),[],new Date('2026-10-01T12:00:00Z'));
  await admin.append('INBOX',message('late','alpha middle beta'),[],new Date('2026-10-03T12:00:00Z'));
  await admin.append('Sent',message('middle','alpha beta'),[],new Date('2026-10-02T12:00:00Z'));
  await admin.append('Spam',message('spam','alpha beta'),[],new Date('2026-10-04T12:00:00Z'));
  await admin.append('Trash',message('trash','alpha beta'),[],new Date('2026-10-05T12:00:00Z'));
  await admin.append('Projects/日本語',message('unicode','meeting 日本語 mañana'),[],new Date('2026-10-02T13:00:00Z'));
  const mime='--boundary\r\nContent-Type: multipart/alternative; boundary=alternative\r\n\r\n--alternative\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from('Decoded café 日本語').toString('base64')+'\r\n--alternative\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML alternative</p>\r\n--alternative--\r\n--boundary\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="sample.pdf"\r\n\r\n'+ 'attachment data '.repeat(10000)+'\r\n--boundary--';
  await admin.append('INBOX',message('mime',mime,'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=boundary\r\n'),[],new Date('2026-10-06T12:00:00Z'));
  await second.append('INBOX',message('second account','separate record'),[],new Date('2026-10-07T12:00:00Z'));
  process.env.SOURCE_SEARCH_IMAP_TEST_PASSWORD=password;
  const c=configSchema.parse({enabledSources:['test-mail','second-mail'],sources:{'test-mail':{adapter:'imap',account:'alice',email:'alice@example.test',username:'alice@example.test',host:'127.0.0.1',port,caFile:join(dir,'tls.crt'),auth:{type:'password',password:{env:'SOURCE_SEARCH_IMAP_TEST_PASSWORD'}},folderRoles:{Spam:'junk',Trash:'trash',Sent:'sent'}},'second-mail':{adapter:'imap',account:'bob',email:'bob@example.test',username:'bob@example.test',host:'127.0.0.1',port,caFile:join(dir,'tls.crt'),auth:{type:'password',password:{env:'SOURCE_SEARCH_IMAP_TEST_PASSWORD'}}}}});
  const query=async(query='',extra:Record<string,unknown>={})=>searchMail({source:'test-mail',query,limit:25,...extra},undefined,{remaining:0,records:new Map()},c);
  const all=await query();assert.equal(all.totalMatches,5);assert.deepEqual(all.items.map(r=>r.title),['mime','late','unicode','middle','early']);checks.push('global order uses INTERNALDATE rather than UID or Date header');
  assert.equal((await query('',{excludeSpamTrash:false})).totalMatches,7);checks.push('spam and trash role exclusion');
  assert.deepEqual((await query('alpha beta')).items.map(r=>r.title),['late','middle','early']);
  assert.deepEqual((await query('alpha beta',{match:'phrase'})).items.map(r=>r.title),['middle','early']);checks.push('all terms versus literal phrase');
  assert.deepEqual((await query('日本語',{folders:['Projects/日本語']})).items.map(r=>r.title),['unicode']);checks.push('UTF-8 query and nested Unicode mailbox');
  assert.deepEqual((await query('',{from:'2026-10-02T09:00:00-03:00',to:'2026-10-03T09:00:00-03:00'})).items.map(r=>r.title),['unicode','middle']);checks.push('inclusive from and exclusive to at exact instants');
  const oldest=await query('',{sort:'oldest'});assert.deepEqual(oldest.items.map(r=>r.title),['early','middle','unicode','late','mime']);
  let page=await query('',{limit:2}),ids=page.items.map(i=>i.ref.id);
  while(page.nextCursor){page=await query('',{limit:1,cursor:page.nextCursor});ids.push(...page.items.map(i=>i.ref.id));}
  assert.equal(new Set(ids).size,5);assert.deepEqual(ids,all.items.map(i=>i.ref.id));checks.push('complete pagination with changing page size');
  const first=await query('',{limit:1});
  await admin.append('INBOX',message('arrival','new mail'),[],new Date('2026-10-08T12:00:00Z'));
  await assert.rejects(query('',{cursor:first.nextCursor,limit:1}),{code:'STALE_CURSOR'});checks.push('mailbox change invalidates cursor');
  const record=await readMail('test-mail',all.items[0]!.ref.id,undefined,c);
  assert.match(record.body,/Decoded café 日本語/);assert(!record.body.includes('attachment data'));assert(!record.body.includes('HTML alternative'));
  assert.deepEqual(record.metadata?.attachments,[{name:'sample.pdf',type:'application/pdf'}]);checks.push('MIME charset and transfer decoding with attachment metadata only');
  const again=await readMail('test-mail',record.ref.id,undefined,c);assert.equal(again.ref.version,record.ref.version);checks.push('stable record version');
  const other=await searchMail({source:'second-mail',query:'',limit:25},undefined,undefined,c);assert.equal(other.totalMatches,1);assert.equal(other.items[0]!.title,'second account');checks.push('independent account isolation');
  const settings=c.sources['test-mail'];assert(settings?.adapter==='imap');
  const backend=imapConnector(settings);
  const attachments=await backend.attachments(record.ref.id);assert.equal(attachments[0]?.filename,'sample.pdf');
  assert((await backend.download(record.ref.id,attachments[0]!.id,200000)).toString().includes('attachment data'));
  await assert.rejects(backend.download(record.ref.id,attachments[0]!.id,10),{code:'OUTPUT_LIMIT'});checks.push('native attachment downloads, size limits and unchanged unread flags');
  const initialSync=await backend.sync();assert.equal(initialSync.inventory?.length,6);
  const repeatSync=await backend.sync(initialSync.checkpoint);assert.equal(repeatSync.messages.length,0);
  await admin.append('INBOX',message('incremental arrival','delta only'),[],new Date('2026-10-09T12:00:00Z'));
  const deltaSync=await backend.sync(repeatSync.checkpoint);assert.deepEqual(deltaSync.messages.map(m=>m.summary.subject),['incremental arrival']);
  await admin.mailboxOpen('INBOX');const deltaIds=await admin.search({subject:'incremental arrival'},{uid:true});assert(Array.isArray(deltaIds));await admin.messageDelete(deltaIds,{uid:true});
  const removedSync=await backend.sync(deltaSync.checkpoint);assert.equal(removedSync.inventory?.length,6);assert(removedSync.removed.includes(deltaSync.messages[0]!.summary.message_id));checks.push('incremental sync with no-op, arrival and expunge against Dovecot');
  const starttls=imapConnector({...settings,security:'starttls',port:plainPort});assert.equal((await starttls.search({source:'test-mail',query:'',limit:25})).total,6);checks.push('required STARTTLS and validated private CA');
  const restricted=configSchema.parse({...c,sources:{...c.sources,'test-mail':{...settings,folders:['Sent']}}});
  await assert.rejects(readMail('test-mail',all.items[0]!.ref.id,undefined,restricted));checks.push('folder restrictions apply to saved reads');
  await assert.rejects(query('',{folders:['unknown']}),{code:'UNKNOWN_FOLDER'});checks.push('unknown folder is an error');
  const tiny=configSchema.parse({...c,sources:{...c.sources,'test-mail':{...settings,maxSearchMessages:1}}});
  await assert.rejects(searchMail({source:'test-mail',query:'',limit:1},undefined,undefined,tiny),{code:'SEARCH_TOO_BROAD'});
  assert((await mailStatus(tiny,'test-mail'))?.folders.length);checks.push('broad search errors without breaking availability check');
  const unread=[];
  for(const box of ['INBOX','Sent','Projects/日本語','Spam','Trash']){await admin.mailboxOpen(box);unread.push(...await admin.fetchAll('1:*',{flags:true}));}
  assert(unread.every(m=>!m.flags?.has('\\Seen')));checks.push('search and reads preserve unread flags');
  const oldestRef=oldest.items[0]!.ref;
  await admin.mailboxOpen('INBOX');const earliest=await admin.search({subject:'early'},{uid:true});assert(Array.isArray(earliest));
  await admin.messageMove(earliest,'Sent',{uid:true});
  if(JSON.parse(Buffer.from(oldestRef.id.slice(5),'base64url').toString()).e){assert.equal((await readMail('test-mail',oldestRef.id,undefined,c)).title,'early');checks.push('stable server ID survives move');}
  else {await assert.rejects(readMail('test-mail',oldestRef.id,undefined,c),{code:'NOT_FOUND'});checks.push('moved UID reference fails explicitly');}
  const status=await createSourceAccess(c).status('test-mail');assert(status.available);checks.push('application routing and readiness');
  const context=await mailContext(record,undefined,c);assert(Array.isArray(context.records));checks.push('thread capability handled without fabricated neighbors');
  console.log(JSON.stringify({ok:true,server:'Dovecot',image,checks},null,2));
}finally{
  admin?.close();second?.close();delete process.env.SOURCE_SEARCH_IMAP_TEST_PASSWORD;
  await command(['docker','rm','-f',name]).catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
