import {identifiers} from '../../domain/identifiers';
import {z} from 'zod';
import {fail,versioned,now} from '../../domain/identity';
import type {HttpRead} from '../../platform/http';
import {checked,pages,identity,identityParts} from '../sync/paging';
import type {SourceProvider} from '../sync/model';

const timestamp=z.string().regex(/^\d+\.\d{6}$/),raw=z.record(z.string(),z.any());
const message=z.object({ts:timestamp,text:z.string().optional(),user:z.string().optional(),username:z.string().optional(),bot_id:z.string().optional(),bot_profile:z.object({name:z.string()}).optional(),thread_ts:timestamp.optional(),reply_count:z.number().int().optional(),subtype:z.string().optional(),blocks:z.array(raw).optional(),attachments:z.array(raw).optional(),files:z.array(z.object({id:z.string(),name:z.string().optional(),title:z.string().optional(),mimetype:z.string().optional()})).optional()});
type Message=z.infer<typeof message>;
const channel=z.object({id:z.string(),name:z.string().optional(),user:z.string().optional()});
const state=z.object({version:z.literal(1),workspace:z.string(),users:z.record(z.string(),z.object({name:z.string(),at:z.string()})),channels:z.array(z.object({id:z.string(),at:timestamp,reconciledAt:z.string(),messages:z.array(message)}))});
type Selection={workspace:string;channels:string[];historyDays:number};
function blockText(value:any,depth=0):string{
  if(depth>30)return '';
  if(Array.isArray(value))return value.map(v=>blockText(v,depth+1)).filter(Boolean).join('\n');
  if(!value||typeof value!=='object')return typeof value==='string'?value:'';
  if(value.type==='user')return '<@'+value.user_id+'>';
  if(value.type==='channel')return '<#'+value.channel_id+'>';
  if(value.type==='emoji')return ':'+value.name+':';
  if(value.type==='link')return value.text||value.url||'';
  return [blockText(value.text,depth+1),blockText(value.elements,depth+1),blockText(value.fields,depth+1)].filter(Boolean).join('\n');
}
export function slackProvider(source:string,selection:Selection,http:HttpRead):SourceProvider{
  let workspaceUrl='',users:Record<string,{name:string;at:string}>={},namesAvailable=true;const warnings=new Set<string>();
  async function api(method:string,args:Record<string,string>={}){
    const response=checked(z.object({ok:z.boolean(),error:z.string().optional()}).passthrough(),await http('/'+method+(method==='auth.test'?'':'?'+new URLSearchParams(args)),method==='auth.test'?{}:undefined));
    if(!response.ok){const error=response.error||'unknown_error',code=['invalid_auth','not_authed','token_expired','token_revoked','missing_scope','no_permission','not_in_channel','access_denied'].includes(error)?'AUTH_REQUIRED':['channel_not_found','thread_not_found','message_not_found','user_not_found'].includes(error)?'RECORD_NOT_FOUND':error==='ratelimited'?'RATE_LIMITED':'PROVIDER_ERROR';throw Object.assign(new Error('Slack returned '+error),{code,slackError:error});}
    return response;
  }
  async function authorize(){const p=checked(z.object({team_id:z.string(),url:z.url()}),await api('auth.test'));if(p.team_id!==selection.workspace)fail('ACCOUNT_CHANGED','Slack token belongs to a different workspace');const u=new URL(p.url);if(u.protocol!=='https:'||!u.hostname.endsWith('.slack.com')||u.username||u.password)fail('INVALID_PROVIDER_RESPONSE','Slack returned an invalid workspace URL');workspaceUrl=u.origin;}
  async function info(id:string){if(!selection.channels.includes(id))fail('INVALID_REFERENCE','Slack channel is not selected');const c=checked(channel,(await api('conversations.info',{channel:id})).channel);if(c.id!==id)fail('INVALID_PROVIDER_RESPONSE','Slack returned a different channel');return c;}
  async function messages(method:'conversations.history'|'conversations.replies',args:Record<string,string>){
    const base='/'+method+'?'+new URLSearchParams({...args,limit:'200'});
    return (await pages(base,async path=>{const u=new URL(path,'https://slack.com'),p=checked(z.object({messages:z.array(message),has_more:z.boolean().optional(),response_metadata:z.object({next_cursor:z.string().optional()}).optional(),is_limited:z.boolean().optional()}),await api(method,Object.fromEntries(u.searchParams)));
      if(p.is_limited)warnings.add('Slack plan or retention limits hide some channel history');
      const cursor=p.response_metadata?.next_cursor?.trim();let next:string|undefined;
      if(cursor)next=base+'&cursor='+encodeURIComponent(cursor);
      else if(p.has_more){if(!p.messages.length)fail('INCOMPLETE_SOURCE','Slack reported more messages without a cursor or timestamp');const boundary=p.messages.at(-1)!.ts;u.searchParams.delete('cursor');u.searchParams.set(method==='conversations.history'?'latest':'oldest',boundary);u.searchParams.set('inclusive','false');next=u.pathname+u.search;}
      return {items:p.messages,next};
    })).items;
  }
  async function userName(id:string){
    if(users[id]&&Date.now()-Date.parse(users[id]!.at)<7*86400000)return users[id]!.name;
    if(!namesAvailable||!id.startsWith('U')&&!id.startsWith('W'))return id;
    try{const p=checked(z.object({user:z.object({id:z.string(),name:z.string().optional(),real_name:z.string().optional(),profile:z.object({display_name:z.string().optional(),real_name:z.string().optional()}).optional()})}),await api('users.info',{user:id}));if(p.user.id!==id)fail('INVALID_PROVIDER_RESPONSE','Slack returned a different user');const name=p.user.profile?.display_name||p.user.profile?.real_name||p.user.real_name||p.user.name||id;users[id]={name,at:now()};return name;}
    catch(e){if((e as any).slackError!=='missing_scope'&&(e as any).slackError!=='user_not_found')throw e;if((e as any).slackError==='missing_scope')namesAvailable=false;warnings.add('Slack user names unavailable; user IDs are retained');return id;}
  }
  async function record(c:z.infer<typeof channel>,p:Message){
    let body=[p.text||blockText(p.blocks),...(p.attachments||[]).map(a=>[a.title,a.text||a.fallback,blockText(a.fields)].filter(Boolean).join('\n')),...(p.files||[]).map(f=>'File: '+(f.title||f.name||f.id)+(f.mimetype?' ('+f.mimetype+')':''))].filter(Boolean).join('\n\n');
    const mentions=[...new Set([...body.matchAll(/<@([UW][A-Z0-9]+)>/g)].map(v=>v[1]!))];for(const id of mentions)body=body.replaceAll('<@'+id+'>','@'+await userName(id));
    body=body.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g,'$2 ($1)').replace(/<(https?:\/\/[^>]+)>/g,'$1').replace(/<#([^>|]+)(?:\|([^>]+))?>/g,(_all,id,name)=>'#'+(name||id)).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    const author=p.user?await userName(p.user):p.bot_profile?.name||p.username||p.bot_id||'Slack';
    return versioned({adapter:'chat',ref:{source,id:identity([selection.workspace,c.id,p.thread_ts||p.ts,p.ts])},title:`#${c.name||c.id} — ${author}`,body:body||`[${p.subtype||'Message without text'}]`,type:'slack-message',locator:workspaceUrl+'/archives/'+encodeURIComponent(c.id)+'/p'+p.ts.replace('.',''),occurredAt:new Date(Number(p.ts)*1000).toISOString(),observedAt:now(),author,conversation:c.id,identifiers:identifiers('person-id',[p.user]),metadata:{provider:'slack',workspace:selection.workspace,channel:c.id,thread:p.thread_ts||p.ts,subtype:p.subtype||'message'}});
  }
  return {async lists(){await authorize();const result=[];for(const id of selection.channels){const c=await info(id);result.push({id,name:c.name||id});}return result;},async sync(previous){
    await authorize();const parsed=state.safeParse(previous),old=parsed.success&&parsed.data.workspace===selection.workspace?parsed.data:undefined;users=old?.users||{};
    const at=(Date.now()/1000).toFixed(6),from=Number(at)-selection.historyDays*86400,saved=[],records=[];let fullAny=false;
    for(const id of selection.channels){const c=await info(id),prior=old?.channels.find(c=>c.id===id),full=!prior||Date.now()-Date.parse(prior.reconciledAt)>86400000,start=full?from:Math.max(from,Number(prior.at)-7*86400);
      const current=await messages('conversations.history',{channel:id,oldest:start.toFixed(6),latest:at,inclusive:'true'});
      const map=new Map((full?[]:prior!.messages).filter(m=>Number(m.thread_ts||m.ts)>=from&&Number(m.thread_ts||m.ts)<start).map(m=>[m.ts,m]));
      for(const p of current)if(Number(p.thread_ts||p.ts)>=from)map.set(p.ts,p);
      const roots=[...map.values()].filter(p=>(!p.thread_ts||p.thread_ts===p.ts)&&!!p.reply_count);
      for(const root of roots){let replies:Message[];try{replies=await messages('conversations.replies',{channel:id,ts:root.ts,latest:at,inclusive:'true'});}catch(e){if((e as any).slackError!=='thread_not_found')throw e;replies=[];}
        for(const [key,value] of map)if((value.thread_ts||value.ts)===root.ts)map.delete(key);
        for(const p of replies){if((p.thread_ts||p.ts)!==root.ts)fail('INVALID_PROVIDER_RESPONSE','Slack returned a message outside its thread');map.set(p.ts,p);}
      }
      const values=[...map.values()];for(const p of values)records.push(await record(c,p));saved.push({id,at,reconciledAt:full?now():prior!.reconciledAt,messages:values});fullAny||=full;
    }
    return {records,checkpoint:{version:1,workspace:selection.workspace,users,channels:saved},coverageWindow:{from:new Date(from*1000).toISOString(),to:new Date(Number(at)*1000).toISOString()},strategy:fullAny?'full-channel-reconciliation':'recent-history-and-known-threads',coverage:`Selected Slack channels: thread roots from the last ${selection.historyDays} days and their replies. Recent seven-day history and known threads refresh each sync; older edits/deletions and first replies to old roots reconcile daily. Workspace retention still applies. File metadata only.`,warnings:[...warnings]};
  },async read(id,previous){await authorize();const [workspace,channelId,thread,ts]=identityParts(id,4);if(workspace!==selection.workspace||!timestamp.safeParse(ts).success||!timestamp.safeParse(thread).success)fail('INVALID_REFERENCE','Invalid Slack message identity');const parsed=state.safeParse(previous);users=parsed.success?parsed.data.users:{};const c=await info(channelId!);
    const method=thread===ts?'conversations.history':'conversations.replies',p=checked(z.object({messages:z.array(message)}),await api(method,{channel:channelId!,...(thread===ts?{}:{ts:thread!}),oldest:ts!,latest:ts!,inclusive:'true',limit:'1'})).messages.find(p=>p.ts===ts);
    if(!p||(p.thread_ts||p.ts)!==thread)fail('RECORD_NOT_FOUND','Slack message was removed');const result=await record(c,p);if(warnings.size)result.warnings=[...warnings];return result;
  }};
}
