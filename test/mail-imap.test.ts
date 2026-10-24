import {test,expect} from 'bun:test';
import type {ImapFlow,FetchMessageObject,SearchObject} from 'imapflow';
import {imapSettings} from '../src/platform/source-settings';
import {imapConnector} from '../src/sources/mail/imap';

function fixture(stable=true){
  const folders=['INBOX','Sent','Junk','Trash'],seen:any[]=[];
  const rows:Record<string,FetchMessageObject[]>={INBOX:[{seq:1,uid:10,...(stable?{emailId:'email1',threadId:'thread1'}:{}),envelope:{subject:'First',from:[{address:'a@example.test'}],messageId:'header1'},internalDate:new Date('2026-01-01T10:00:00Z'),size:10}],Sent:[],Junk:[],Trash:[]};
  let validity='11',closed=0,failConnect=false,hang=false;
  const create=(options:any)=>{
    seen.push({options});
    const client:any={capabilities:new Map(stable?[['OBJECTID',true]]:[]),mailbox:false,
      on:()=>{},connect:async()=>{if(hang)return new Promise(()=>{});if(failConnect)throw Object.assign(new Error('sensitive-provider-detail'),{authenticationFailed:true});},close:()=>{closed++;},
      list:async()=>folders.map(path=>({path,flags:new Set(),specialUse:path==='INBOX'?'\\Inbox':'\\'+path})),
      getMailboxLock:async(path:string,options:any)=>{seen.push({path,options});client.mailbox={path,uidValidity:validity};return {release(){seen.push({released:true});}};},
      search:async(q:SearchObject,options:any)=>{seen.push({query:q,options});return rows[client.mailbox.path]!.filter(r=>(!q.emailId || r.emailId===q.emailId) && (!q.threadId||r.threadId===q.threadId)).map(r=>r.uid);},
      fetchAll:async(ids:number[],q:any,options:any)=>{seen.push({fetch:ids,q,options});return rows[client.mailbox.path]!.filter(r=>ids.includes(r.uid));},
      fetchOne:async(uid:number,q:any,options:any)=>{seen.push({one:uid,q,options});const row=rows[client.mailbox.path]!.find(r=>r.uid===uid);if(!row)return false;return {...row,bodyStructure:{part:'1',type:'text/plain',size:10},...(q.bodyParts?{bodyParts:new Map([['1',Buffer.from('plain body')]])}:{})};},
    };
    return client as ImapFlow;
  };
  process.env.SOURCE_SEARCH_UNIT_IMAP='invented';
  const settings=imapSettings.parse({adapter:'imap',account:'test',email:'a@example.test',host:'imap.example.test',username:'a@example.test',auth:{type:'password',password:{env:'SOURCE_SEARCH_UNIT_IMAP'}}});
  return {rows,seen,settings,connector:imapConnector(settings,create),create,setValidity:(v:string)=>{validity=v;},setConnectFailure:()=>{failConnect=true;},setHang:()=>{hang=true;},closed:()=>closed};
}
test('IMAP stable server IDs deduplicate folders and survive moves',async()=>{
  const f=fixture(),q={source:'test-mail',query:'',limit:10};
  f.rows.Sent=[{...f.rows.INBOX![0]!,uid:20}];
  const results=await f.connector.search(q);expect(results.total).toBe(1);expect(results.messages[0]!.folders.map(f=>f.id)).toEqual(['INBOX','Sent']);
  const id=results.messages[0]!.message_id;f.rows.INBOX=[];
  expect((await f.connector.read(id)).summary.message_id).toBe(id);
  expect(f.seen.filter(x=>x.path).every(x=>x.options.readOnly===true)).toBe(true);
  expect(f.seen.filter(x=>x.fetch || x.one || x.query).every(x=>x.options.uid===true)).toBe(true);
  expect(f.closed()).toBe(2);
});
test('IMAP preserves distinct copies without stable IDs even if header Message-ID is identical',async()=>{
  const f=fixture(false);f.rows.Sent=[{...f.rows.INBOX![0]!,uid:20}];
  const result=await f.connector.search({source:'test-mail',query:'',limit:10});
  expect(result.total).toBe(2);expect(result.messages[0]!.message_id).not.toBe(result.messages[1]!.message_id);expect(result.warnings.join(' ')).toContain('copies');
});
test('IMAP rejects reused UIDs after UIDVALIDITY changes',async()=>{
  const f=fixture(false),result=await f.connector.search({source:'test-mail',query:'',limit:10});
  f.setValidity('12');
  await expect(f.connector.read(result.messages[0]!.message_id)).rejects.toMatchObject({code:'STALE_RECORD'});
});
test('IMAP excludes stable IDs appearing in junk even when also in an ordinary folder',async()=>{
  const f=fixture();f.rows.Junk=[{...f.rows.INBOX![0]!,uid:50}];
  expect((await f.connector.search({source:'test-mail',query:'',limit:10})).total).toBe(0);
  expect((await f.connector.search({source:'test-mail',query:'',limit:10,excludeSpamTrash:false})).total).toBe(1);
});
test('IMAP threads use server identity and keep selected-folder restrictions',async()=>{
  const f=fixture();f.rows.Sent=[{...f.rows.INBOX![0]!,uid:20,emailId:'email2'}];
  const result=await f.connector.search({source:'test-mail',query:'',limit:10}),id=result.messages.find(m=>m.subject==='First')!.message_id;
  const thread=await f.connector.thread('thread1',id);expect(thread.messages).toHaveLength(2);
  const restricted=imapConnector({...f.settings,folders:['INBOX']},f.create);
  expect((await restricted.thread('thread1',id)).messages).toHaveLength(1);
});
test('IMAP timeout closes the client and authentication errors omit provider details',async()=>{
  const f=fixture();f.setConnectFailure();await expect(f.connector.status()).rejects.toMatchObject({code:'AUTHENTICATION_FAILED'});expect(f.closed()).toBe(1);
  const g=fixture();g.setHang();await expect(imapConnector({...g.settings,timeoutMs:100},g.create).status()).rejects.toMatchObject({code:'TIMEOUT'});expect(g.closed()).toBeGreaterThan(0);
});
test('IMAP OAuth passes tokens to the library and STARTTLS is mandatory when selected',async()=>{
  const f=fixture();await imapConnector({...f.settings,security:'starttls',port:143,auth:{type:'oauth2',accessToken:{env:'SOURCE_SEARCH_UNIT_IMAP'}}},f.create).status();
  const options=f.seen[0].options;
  expect(options.auth).toEqual({user:'a@example.test',accessToken:'invented'});expect(options.doSTARTTLS).toBe(true);expect(options.tls.rejectUnauthorized).toBe(true);expect(options.logger).toBe(false);
});
