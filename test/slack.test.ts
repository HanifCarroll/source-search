import {test,expect} from 'bun:test';
import {slackProvider} from '../src/sources/chat/slack';
import {identity} from '../src/sources/sync/paging';

const selection={workspace:'TINVENTED',channels:['CLAB'],historyDays:36500};
const root={ts:'1792840000.000001',user:'UINVENTED',text:'Invented telescope <@UFRIEND>',reply_count:1};
const reply={ts:'1792840001.000002',thread_ts:root.ts,user:'UFRIEND',text:'Compare prisms'};
test('Slack follows empty cursor pages, indexes thread replies and files, handles edited/deleted replies, and reads current originals',async()=>{
  let phase=0;const seen:string[]=[];
  const provider=slackProvider('slack',selection,async path=>{
    seen.push(path);const u=new URL(path,'https://slack.com'),method=u.pathname;
    if(method==='/auth.test')return {ok:true,team_id:'TINVENTED',url:'https://invented.slack.com/'};
    if(method==='/conversations.info')return {ok:true,channel:{id:'CLAB',name:'research'}};
    if(method==='/users.info')return {ok:true,user:{id:u.searchParams.get('user'),profile:{display_name:u.searchParams.get('user')==='UFRIEND'?'Invented colleague':'Invented author'}}};
    if(method==='/conversations.history')return u.searchParams.has('cursor')?{ok:true,messages:[root],has_more:false}:{ok:true,messages:[],response_metadata:{next_cursor:'opaque-next'}};
    if(u.searchParams.get('oldest')===reply.ts)return {ok:true,messages:phase===2?[]:[{...reply,text:phase?'Changed prisms':reply.text}]};
    return {ok:true,messages:phase===2?[{...root,reply_count:0}]:[root,{...reply,text:phase?'Changed prisms':reply.text,files:[{id:'FINVENTED',name:'diagram.pdf',mimetype:'application/pdf'}]}],has_more:false};
  });
  const first=await provider.sync();expect(first.records).toHaveLength(2);expect(first.records[0]!.body).toContain('@Invented colleague');expect(first.records[1]!.body).toContain('File: diagram.pdf');
  phase=1;const changed=await provider.sync(first.checkpoint);expect(changed.records[1]!.body).toContain('Changed prisms');
  expect((await provider.read(first.records[1]!.ref.id,first.checkpoint)).body).toBe('Changed prisms');
  phase=2;expect((await provider.sync(changed.checkpoint)).records).toHaveLength(1);
  await expect(provider.read(first.records[1]!.ref.id)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  expect(seen.some(p=>p.includes('cursor=opaque-next'))).toBe(true);
});
test('Slack detects account mismatch and API failures rather than publishing an empty history',async()=>{
  await expect(slackProvider('slack',selection,async()=>({ok:true,team_id:'TOTHER',url:'https://other.slack.com/'})).sync()).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});
  const provider=slackProvider('slack',selection,async path=>path==='/auth.test'?{ok:true,team_id:selection.workspace,url:'https://invented.slack.com/'}:path.startsWith('/conversations.info')?{ok:true,channel:{id:'CLAB'}}:{ok:false,error:'missing_scope'});
  await expect(provider.sync()).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  await expect(provider.read(identity([selection.workspace,'COTHER',root.ts,root.ts]))).rejects.toMatchObject({code:'INVALID_REFERENCE'});
});
test('Slack reconciles old first replies daily and reports unavailable names and history retention',async()=>{
  let phase=0;
  const old={...root,ts:'1700000000.000001',reply_count:0},recent={...root,reply_count:0};
  const provider=slackProvider('slack',selection,async path=>{
    const u=new URL(path,'https://slack.com');
    if(u.pathname==='/auth.test')return {ok:true,team_id:selection.workspace,url:'https://invented.slack.com/'};
    if(u.pathname==='/conversations.info')return {ok:true,channel:{id:'CLAB'}};
    if(u.pathname==='/users.info')return {ok:false,error:'missing_scope'};
    if(u.pathname==='/conversations.replies')return {ok:true,messages:[{...old,reply_count:1},{...reply,thread_ts:old.ts,text:'New reply to old root'}]};
    return {ok:true,is_limited:true,messages:Number(u.searchParams.get('oldest'))<Number(old.ts)?[{...old,reply_count:phase?1:0},recent]:[recent]};
  });
  const first=await provider.sync();expect(first.warnings.join(' ')).toContain('retention');expect(first.warnings.join(' ')).toContain('user IDs');
  phase=1;const daily=structuredClone(first.checkpoint) as any;daily.channels[0].reconciledAt='2020-01-01T00:00:00Z';expect((await provider.sync(daily)).records.some(r=>r.body==='New reply to old root')).toBe(true);
});
