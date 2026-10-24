import {z} from 'zod';
import {fail} from '../../domain/identity';
import {words} from '../../domain/query';
import type {Query} from '../../domain/contracts';
import type {JmapSettings} from '../../platform/source-settings';
import {readSecret} from './credentials';
import type {Folder,MailConnector,MailContinuation,MailDetail,MailSummary} from './types';

const CORE='urn:ietf:params:jmap:core', MAIL='urn:ietf:params:jmap:mail';
const idSchema=z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const boxesSchema=z.array(z.object({id:idSchema,name:z.string(),role:z.string().nullable()}));
const emailSchema=z.object({
  id:idSchema,threadId:idSchema,mailboxIds:z.record(z.string(),z.boolean()),receivedAt:z.iso.datetime(),
  subject:z.string().nullable(),preview:z.string(),
  from:z.array(z.object({name:z.string().nullish(),email:z.string()})).nullable(),
  to:z.array(z.object({name:z.string().nullish(),email:z.string()})).nullable(),
  cc:z.array(z.object({name:z.string().nullish(),email:z.string()})).nullable().optional(),
  messageId:z.array(z.string()).nullable().optional(),
  textBody:z.array(z.object({partId:z.string().nullable()})).optional(),
  htmlBody:z.array(z.object({partId:z.string().nullable()})).optional(),
  bodyValues:z.record(z.string(),z.object({value:z.string(),isTruncated:z.boolean().optional(),isEncodingProblem:z.boolean().optional()})).optional(),
  attachments:z.array(z.object({name:z.string().nullable(),type:z.string(),blobId:idSchema.optional(),partId:z.string().nullable().optional(),size:z.number().int().nonnegative().optional()})).optional(),
});
type Email=z.infer<typeof emailSchema>;
function parse<T>(schema:z.ZodType<T>,data:unknown):T {
  const result=schema.safeParse(data);
  if(!result.success)fail('INVALID_PROVIDER_RESPONSE','JMAP returned malformed data');
  return result.data;
}
function providerId(id:string){return parse(idSchema,id);}
function address(a:{name?:string|null;email:string}){return a.name ? `${a.name} <${a.email}>` : a.email;}
function resolveFolders(boxes:Folder[],names:string[]):Folder[]{
  return names.map(name=>{
    const exact=boxes.find(b=>b.id===name);
    if(exact)return exact;
    const found=boxes.filter(b=>b.name.toLowerCase()===name.toLowerCase() || b.role===name.toLowerCase());
    if(found.length!==1)fail('UNKNOWN_FOLDER','Folder is missing or ambiguous; use its exact mailbox ID');
    return found[0]!;
  });
}

class Session {
  private apiUrl='';
  private accountId='';
  private authorization='';
  private downloadUrl='';
  private maxGet=1;
  private signal:AbortSignal;
  constructor(private settings:JmapSettings,signal:AbortSignal){this.signal=signal;}
  private async request(url:string,body?:unknown,redirects=0):Promise<any>{
    const u=new URL(url), original=new URL(this.settings.sessionUrl);
    if(u.username || u.password || (u.protocol!=='https:' && !(u.origin===original.origin && original.protocol==='http:')))
      fail('INVALID_PROVIDER_RESPONSE','JMAP returned an unsupported API URL');
    const response=await fetch(u,{method:body===undefined?'GET':'POST',headers:{Authorization:this.authorization,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:this.signal,redirect:'manual'});
    if(response.status>=300 && response.status<400){
      await response.body?.cancel();
      const location=response.headers.get('location'),target=location?new URL(location,u):undefined;
      if(body!==undefined || !target || target.origin!==u.origin || redirects>=3)fail('MAIL_CONNECTION_FAILED','Use the canonical JMAP session URL; API or cross-origin redirects are not followed');
      return this.request(target.href,undefined,redirects+1);
    }
    if(!response.ok){
      await response.body?.cancel();
      fail(response.status===401 || response.status===403 ? 'AUTHENTICATION_FAILED' : response.status===429 ? 'RATE_LIMITED' : 'MAIL_CONNECTION_FAILED',`JMAP request failed (HTTP ${response.status}); check account access or retry later`);
    }
    const reader=response.body?.getReader();if(!reader)fail('INVALID_PROVIDER_RESPONSE','Empty JMAP response');
    const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)fail('OUTPUT_LIMIT','JMAP response exceeded 8 MiB');chunks.push(value);}}
    finally {await reader.cancel().catch(()=>{});}
    try{return JSON.parse(Buffer.concat(chunks).toString());}catch{return fail('INVALID_PROVIDER_RESPONSE','JMAP did not return JSON');}
  }
  async connect(){
    const auth=this.settings.auth;
    this.authorization=auth.type==='bearer' ? 'Bearer '+await readSecret(auth.token) : 'Basic '+Buffer.from(auth.username+':'+await readSecret(auth.password)).toString('base64');
    const session=parse(z.object({apiUrl:z.url(),downloadUrl:z.string().optional(),capabilities:z.record(z.string(),z.unknown()),primaryAccounts:z.record(z.string(),z.string()),accounts:z.record(z.string(),z.object({accountCapabilities:z.record(z.string(),z.unknown())}))}),await this.request(this.settings.sessionUrl));
    if(!(MAIL in session.capabilities) || !(CORE in session.capabilities))fail('UNSUPPORTED_PROVIDER','Server does not advertise JMAP Mail');
    const accountId=this.settings.accountId || session.primaryAccounts[MAIL];
    if(!accountId || !session.accounts[accountId]?.accountCapabilities[MAIL])fail('SOURCE_NOT_CONFIGURED','Select an accessible JMAP mail accountId');
    const core=parse(z.object({maxObjectsInGet:z.number().int().positive()}),session.capabilities[CORE]);
    this.accountId=accountId;this.apiUrl=session.apiUrl;this.maxGet=Math.min(core.maxObjectsInGet,100);
    this.downloadUrl=session.downloadUrl||'';
  }
  async call(method:'Mailbox/get'|'Email/query'|'Email/get'|'Thread/get',args:Record<string,unknown>):Promise<any>{
    const response=await this.request(this.apiUrl,{using:[CORE,MAIL],methodCalls:[[method,{...args,accountId:this.accountId},'read']]});
    const result=response?.methodResponses?.find((r:any)=>Array.isArray(r) && r[2]==='read');
    if(result?.[0]==='error'){
      const type=result[1]?.type;
      fail(type==='unsupportedFilter'?'UNSUPPORTED_FILTER':type==='unsupportedSort'?'UNSUPPORTED_SORT':type==='accountNotFound'?'SOURCE_NOT_CONFIGURED':type==='forbidden'?'PERMISSION_DENIED':'MAIL_PROVIDER_ERROR',`JMAP ${method} failed; ${['unsupportedFilter','unsupportedSort','accountNotFound','forbidden','serverFail','serverUnavailable','tooManyObjects'].includes(type)?type:'provider rejected the request'}`);
    }
    if(result?.[0]!==method || result[1]?.accountId!==this.accountId)fail('INVALID_PROVIDER_RESPONSE','Unexpected JMAP method or account');
    return result[1];
  }
  async boxes(){return parse(boxesSchema,(await this.call('Mailbox/get',{properties:['id','name','role']})).list);}
  async status(){const boxes=await this.boxes();return {folders:this.settings.folders?resolveFolders(boxes,this.settings.folders):boxes,warnings:[]};}
  async emails(ids:string[],body:boolean){
    const records:Email[]=[];
    for(let i=0;i<ids.length;i+=Math.min(this.maxGet,body?1:100)){
      const batch=ids.slice(i,i+Math.min(this.maxGet,body?1:100));
      batch.forEach(providerId);
      const result=await this.call('Email/get',{ids:batch,properties:['id','threadId','mailboxIds','receivedAt','from','to','cc','messageId','subject','preview','textBody','htmlBody','bodyValues','attachments'],bodyProperties:['partId','blobId','size','name','type','charset','disposition','cid'],fetchTextBodyValues:body,fetchHTMLBodyValues:body,fetchAllBodyValues:false,maxBodyValueBytes:2000000});
      const list=parse(z.array(emailSchema),result.list);
      if(result.notFound?.length)fail('NOT_FOUND','A requested email no longer exists');
      const byId=new Map(list.map(e=>[e.id,e]));
      if(byId.size!==batch.length || list.length!==batch.length || batch.some(id=>!byId.has(id)))fail('INVALID_PROVIDER_RESPONSE','JMAP returned different email IDs');
      records.push(...batch.map(id=>byId.get(id)!));
    }
    return records;
  }
  summary(e:Email,boxes:Folder[]):MailSummary{
    const complete=this.settings.recordFormat==='complete';
    return {message_id:e.id,thread_id:e.threadId,subject:e.subject,from:e.from?.length?(complete?e.from.map(address).join(', '):address(e.from.at(-1)!)):null,to:(e.to||[]).map(address),date:e.receivedAt,snippet:e.preview,folders:boxes.filter(b=>e.mailboxIds[b.id]),...(complete?{cc:(e.cc||[]).map(address),messageId:e.messageId?.[0]}:{})};
  }
  detail(e:Email,boxes:Folder[]):MailDetail{
    const value=(parts:{partId:string|null}[]=[])=>{
      const selected=this.settings.recordFormat==='complete'?parts:parts.slice(0,1);
      if(selected.some(p=>p.partId && !e.bodyValues?.[p.partId]))fail('INVALID_PROVIDER_RESPONSE','JMAP omitted a requested text body');
      return selected.map(p=>p.partId?e.bodyValues?.[p.partId]?.value||'':'').join('\n\n');
    };
    return {summary:this.summary(e,boxes),body_text:value(e.textBody),body_html:value(e.htmlBody),attachments:(e.attachments||[]).map(a=>({filename:a.name??'attachment.bin',mime_type:a.type})),warnings:[...(Object.values(e.bodyValues||{}).some(v=>v.isTruncated)?['Message body is truncated at the 2 MB provider limit.']:[]),...(Object.values(e.bodyValues||{}).some(v=>v.isEncodingProblem)?['Provider reported a text decoding problem.']:[])]};
  }
  checkAccess(e:Email,boxes:Folder[]){if(this.settings.folders && !resolveFolders(boxes,this.settings.folders).some(b=>e.mailboxIds[b.id]))fail('SOURCE_RESTRICTED','Email is outside the configured folders');}
  async search(q:Query,page?:MailContinuation){
    const boxes=await this.boxes(),extra:unknown[]=[];
    if(q.from)extra.push({after:new Date(q.from).toISOString()});
    if(q.to)extra.push({before:new Date(q.to).toISOString()});
    if(q.excludeSpamTrash!==false){const excluded=boxes.filter(b=>b.role==='junk'||b.role==='trash');if(excluded.length)extra.push({operator:'NOT',conditions:[{operator:'OR',conditions:excluded.map(b=>({inMailbox:b.id}))}]});}
    for(const names of [this.settings.folders,q.folders])if(names?.length)extra.push({operator:'OR',conditions:resolveFolders(boxes,names).map(b=>({inMailbox:b.id}))});
    const quote=(s:string)=>'"'+s.replace(/[\\"']/g,'\\$&')+'"';
    const terms=this.settings.recordFormat==='mailbridge-v1'?words(q.query):q.query.trim().split(/\s+/u).filter(Boolean);
    const text=q.query.trim()?(q.match==='phrase'?quote(q.query):q.match==='words'?terms.map(quote).join(' '):q.query).trim():'';
    const conditions:unknown[]=[];if(text)conditions.push({text});if(extra.length)conditions.push({operator:'AND',conditions:extra});
    const offset=page?.position||0;
    const result=parse(z.object({ids:z.array(idSchema),position:z.number().int().nonnegative(),queryState:z.string().min(1).max(1000),total:z.number().int().nonnegative()}),await this.call('Email/query',{limit:q.limit,position:offset,calculateTotal:true,sort:[{property:'receivedAt',isAscending:q.sort==='oldest'}],...(conditions.length?{filter:{operator:'AND',conditions}}:{})}));
    if(page && page.state!==result.queryState)fail('STALE_CURSOR','Mail search changed; restart without its cursor');
    if(result.position!==offset || result.ids.length>q.limit || new Set(result.ids).size!==result.ids.length || offset+result.ids.length>result.total || (!result.ids.length && offset<result.total))fail('INVALID_PROVIDER_RESPONSE','Invalid JMAP search page');
    const emails=await this.emails(result.ids,false);
    emails.forEach(e=>this.checkAccess(e,boxes));
    return {messages:emails.map(e=>this.summary(e,boxes)),position:result.position,queryState:result.queryState,total:result.total,warnings:[]};
  }
  async read(id:string){
    const boxes=await this.boxes();providerId(id);
    if(this.settings.folders){const [metadata]=await this.emails([id],false);this.checkAccess(metadata!,boxes);}
    const [e]=await this.emails([id],true);this.checkAccess(e!,boxes);return this.detail(e!,boxes);
  }
  private async attachmentEmail(id:string){const boxes=await this.boxes(),[email]=await this.emails([providerId(id)],false);this.checkAccess(email!,boxes);return email!;}
  async attachments(id:string){return (await this.attachmentEmail(id)).attachments?.map(a=>{if(!a.blobId || a.size===undefined)fail('UNSUPPORTED_PROVIDER','JMAP attachment metadata lacks blob ID or size');return {id:a.blobId,filename:a.name||'attachment.bin',mime_type:a.type,size:a.size};})||[];}
  async download(id:string,attachment:string,maxBytes:number){
    const item=(await this.attachments(id)).find(a=>a.id===attachment);if(!item)fail('NOT_FOUND','Attachment is absent from this email');
    if(item.size>maxBytes)fail('OUTPUT_LIMIT','Attachment exceeds download budget');
    if(!this.downloadUrl)fail('UNSUPPORTED_PROVIDER','JMAP session has no download URL');
    const fields:Record<string,string>={accountId:this.accountId,blobId:attachment,name:item.filename,type:item.mime_type};
    const target=new URL(this.downloadUrl.replace(/\{(accountId|blobId|name|type)\}/g,(_,key)=>encodeURIComponent(fields[key]!)));
    const original=new URL(this.settings.sessionUrl);
    if(target.username||target.password||target.hash||target.protocol!=='https:' && target.origin!==original.origin)fail('INVALID_PROVIDER_RESPONSE','Unsupported attachment download URL');
    const response=await fetch(target,{headers:{Authorization:this.authorization},signal:this.signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();fail('MAIL_PROVIDER_ERROR','Attachment download failed');}
    const reader=response.body?.getReader();if(!reader)fail('INVALID_PROVIDER_RESPONSE','Empty attachment response');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)fail('OUTPUT_LIMIT','Attachment exceeds download budget');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    if(size!==item.size)fail('INVALID_PROVIDER_RESPONSE','Attachment byte count differs from metadata');return Buffer.concat(chunks);
  }
  async thread(id:string,selectedId:string){
    const boxes=await this.boxes(),result=await this.call('Thread/get',{ids:[providerId(id)],properties:['id','emailIds']});
    const threads=parse(z.array(z.object({id:idSchema,emailIds:z.array(idSchema)})),result.list);
    if(threads.length!==1 || threads[0]!.id!==id)fail('NOT_FOUND','Mail thread is unavailable');
    const ids=threads[0]!.emailIds,index=ids.indexOf(selectedId);if(index<0)fail('PARTIAL_CONTEXT','Selected email is absent from its thread');
    let selected=ids.slice(Math.max(0,index-5),index+6);
    const allowed=this.settings.folders?new Set(resolveFolders(boxes,this.settings.folders).map(b=>b.id)):undefined;
    if(allowed)selected=(await this.emails(selected,false)).filter(e=>[...allowed].some(id=>e.mailboxIds[id])).map(e=>e.id);
    const emails=await this.emails(selected,true);
    return {messages:emails.filter(e=>!allowed || [...allowed].some(id=>e.mailboxIds[id])).map(e=>this.detail(e,boxes)),warnings:['Context shows up to five neighbors on each side within configured folders.']};
  }
}

export function jmapConnector(settings:JmapSettings):MailConnector {
  async function use<T>(fn:(s:Session)=>Promise<T>){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),settings.timeoutMs);
    try {const session=new Session(settings,controller.signal);await session.connect();return await fn(session);}
    catch(e){
      if(controller.signal.aborted)fail('TIMEOUT','JMAP request timed out');
      if(['CREDENTIAL_UNAVAILABLE','INVALID_PROVIDER_RESPONSE','AUTHENTICATION_FAILED','RATE_LIMITED','MAIL_CONNECTION_FAILED','OUTPUT_LIMIT','UNSUPPORTED_PROVIDER','SOURCE_NOT_CONFIGURED','UNSUPPORTED_FILTER','UNSUPPORTED_SORT','PERMISSION_DENIED','MAIL_PROVIDER_ERROR','UNKNOWN_FOLDER','NOT_FOUND','SOURCE_RESTRICTED','STALE_CURSOR','PARTIAL_CONTEXT'].includes((e as any)?.code))throw e;
      return fail('MAIL_CONNECTION_FAILED','Could not reach JMAP; check the session URL and TLS connection');
    }
    finally {clearTimeout(timer);}
  }
  return {status:()=>use(s=>s.status()),search:(q,p)=>use(s=>s.search(q,p)),read:id=>use(s=>s.read(id)),thread:(id,selected)=>use(s=>s.thread(id,selected)),attachments:id=>use(s=>s.attachments(id)),download:(id,a,max)=>use(s=>s.download(id,a,max))};
}
