import {ImapFlow,type FetchMessageObject,type MessageStructureObject,type SearchObject,type ImapFlowOptions} from 'imapflow';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {fail,hash,stableJson} from '../../domain/identity';
import {parseMimeMessage} from '../../formats/mime';
import type {Query} from '../../domain/contracts';
import type {ImapSettings} from '../../platform/source-settings';
import {readSecret} from './credentials';
import type {Folder,MailConnector,MailContinuation,MailDetail,MailSummary} from './types';

const refSchema=z.union([
  z.object({e:z.string().min(1).max(255)}).strict(),
  z.object({f:z.string().min(1).max(1000),v:z.string().regex(/^\d+$/),u:z.number().int().positive()}).strict(),
]);
type ImapRef=z.infer<typeof refSchema>;
type Candidate={ref:ImapRef;message:FetchMessageObject;folder:Folder;folders:Folder[];validity:string;date:string};
const encode=(ref:ImapRef)=>'imap_'+Buffer.from(JSON.stringify(ref)).toString('base64url');
function decode(id:string):ImapRef{
  try{if(!id.startsWith('imap_') || id.length>4000)throw Error();return refSchema.parse(JSON.parse(Buffer.from(id.slice(5),'base64url').toString()));}
  catch{return fail('INVALID_REFERENCE','Invalid IMAP reference');}
}
const textCompare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const formatAddress=(a:{name?:string;address?:string})=>a.name&&a.address?`${a.name} <${a.address}>`:a.address||a.name||'';
const roleNames:Record<string,string>={'\\Inbox':'inbox','\\Sent':'sent','\\Drafts':'drafts','\\Archive':'archive','\\Junk':'junk','\\Trash':'trash','\\All':'all'};
function role(path:string,special:string|undefined,s:ImapSettings){return s.folderRoles[path] || roleNames[special||''] || (path.toUpperCase()==='INBOX'?'inbox':null);}
function resolveFolders(boxes:Folder[],names:string[]){
  return names.map(name=>{
    const exact=boxes.find(b=>b.id===name);if(exact)return exact;
    const found=boxes.filter(b=>b.role===name.toLowerCase() || b.name.toLowerCase()===name.toLowerCase());
    if(found.length!==1)fail('UNKNOWN_FOLDER','Folder is missing or ambiguous; use its exact full path');
    return found[0]!;
  });
}
function receivedAt(m:FetchMessageObject){const d=new Date(m.internalDate||'');if(!Number.isFinite(d.getTime()))fail('INVALID_PROVIDER_RESPONSE','IMAP message has no valid INTERNALDATE');return d.toISOString();}
function summary(c:Candidate):MailSummary{
  const e=c.message.envelope;
  return {message_id:encode(c.ref),subject:e?.subject,from:e?.from?.map(formatAddress).join(', '),to:(e?.to||[]).map(formatAddress),cc:(e?.cc||[]).map(formatAddress),date:c.date,snippet:'',thread_id:c.message.threadId,folders:c.folders,messageId:e?.messageId};
}
function leaves(node:MessageStructureObject):MessageStructureObject[]{return node.childNodes?.length?node.childNodes.flatMap(leaves):[node];}
function textParts(node:MessageStructureObject):MessageStructureObject[]{
  if(node.disposition==='attachment' || node.dispositionParameters?.filename || node.parameters?.name || node.type==='message/rfc822')return [];
  if(node.type==='multipart/alternative'){
    const options=(node.childNodes||[]).map(textParts);
    return options.find(parts=>parts.some(p=>p.type==='text/plain')) || options.find(p=>p.length) || [];
  }
  if(node.childNodes?.length)return node.childNodes.flatMap(textParts);
  return ['text/plain','text/html'].includes(node.type)?[node]:[];
}

class Session {
  constructor(private client:ImapFlow,private settings:ImapSettings){}
  private stableIds(){return this.client.capabilities.has('OBJECTID') || this.client.capabilities.has('X-GM-EXT-1');}
  async boxes(){
    const list=await this.client.list({listOnly:true});
    const boxes=list.filter(b=>!b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent')).map(b=>({id:b.path,name:b.path,role:role(b.path,b.specialUse,this.settings)}));
    if(this.allowed(boxes).length>200)fail('SEARCH_TOO_BROAD','Account has over 200 selected folders; configure a smaller folder selection');
    return boxes;
  }
  async status(){const boxes=await this.boxes();return {folders:this.allowed(boxes),warnings:[]};}
  private async inBox<T>(box:Folder,fn:(validity:string)=>Promise<T>){
    const lock=await this.client.getMailboxLock(box.id,{readOnly:true});
    try {
      const mailbox=this.client.mailbox;
      if(!mailbox || !mailbox.uidValidity)fail('INVALID_PROVIDER_RESPONSE','Mailbox did not report UIDVALIDITY');
      return await fn(String(mailbox.uidValidity));
    }finally{lock.release();}
  }
  private allowed(boxes:Folder[]){return this.settings.folders?resolveFolders(boxes,this.settings.folders):boxes;}
  private async ids(query:SearchObject){
    const ids=await this.client.search(query,{uid:true});
    if(ids===false)return [];
    if(!Array.isArray(ids) || ids.some(id=>!Number.isSafeInteger(id)||id<1) || new Set(ids).size!==ids.length)fail('INVALID_PROVIDER_RESPONSE','Invalid IMAP UID search result');
    if(ids.length>this.settings.maxSearchMessages)fail('SEARCH_TOO_BROAD','Too many matching messages; narrow the dates or folders, or increase maxSearchMessages');
    return ids;
  }
  private async collect(boxes:Folder[],query:SearchObject):Promise<Candidate[]>{
    const records:Candidate[]=[];
    for(const box of boxes)await this.inBox(box,async validity=>{
      const ids=await this.ids(query);
      if(records.length+ids.length>this.settings.maxSearchMessages)fail('SEARCH_TOO_BROAD','Too many matching messages across folders; narrow the dates or folders');
      for(let offset=0;offset<ids.length;offset+=200){
        const batch=ids.slice(offset,offset+200);
        const messages=await this.client.fetchAll(batch,{uid:true,envelope:true,internalDate:true,size:true,threadId:true},{uid:true});
        if(messages.length!==batch.length || new Set(messages.map(m=>m.uid)).size!==batch.length || messages.some(m=>!batch.includes(m.uid)))fail('STALE_CURSOR','Mailbox changed during search; restart the query');
        for(const message of messages){
          const ref:ImapRef=message.emailId?{e:message.emailId}:{f:box.id,v:validity,u:message.uid};
          records.push({ref,message,folder:box,folders:[box],validity,date:receivedAt(message)});
        }
      }
    });
    return records;
  }
  private merge(records:Candidate[]){
    const unique=new Map<string,Candidate>();
    for(const row of records){const key=encode(row.ref),old=unique.get(key);if(old){old.folders.push(...row.folders.filter(b=>!old.folders.some(o=>o.id===b.id)));}else unique.set(key,row);}
    return [...unique.values()];
  }
  private query(q:Query):SearchObject{
    const terms=(q.match==='phrase'?[q.query.trim()]:q.query.trim().split(/\s+/u)).filter(Boolean);
    if(terms.length>50)fail('INVALID_QUERY','Use at most 50 mail search terms');
    // De Morgan expresses an AND of TEXT terms using ImapFlow's typed search API.
    const query:SearchObject=terms.length===1?{text:terms[0]}:terms.length?{not:{or:terms.map(text=>({not:{text}}))}}:{all:true};
    // IMAP searches calendar dates ignoring offset. Widen first, then compare exact instants.
    const day=86400000;
    if(q.from)query.since=new Date(Date.parse(q.from)-day).toISOString().slice(0,10);
    if(q.to)query.before=new Date(Date.parse(q.to)+2*day).toISOString().slice(0,10);
    return query;
  }
  async search(q:Query,page?:MailContinuation){
    const all=await this.boxes(),allowed=this.allowed(all);
    let boxes=q.folders?.length?resolveFolders(allowed,q.folders):allowed;
    if(q.excludeSpamTrash!==false)boxes=boxes.filter(b=>b.role!=='junk' && b.role!=='trash');
    const warnings:string[]=[];
    if(q.excludeSpamTrash!==false && (!all.some(b=>b.role==='junk') || !all.some(b=>b.role==='trash')))warnings.push('Server does not identify every spam/trash folder; configure folderRoles to exclude unlabelled folders.');
    const raw=await this.collect(boxes,this.query(q));
    const excluded=new Set<string>();
    if(q.excludeSpamTrash!==false && this.stableIds()){
      for(const r of await this.collect(allowed.filter(b=>b.role==='junk'||b.role==='trash'),this.query(q)))if(r.message.emailId)excluded.add(r.message.emailId);
    }
    const records=this.merge(raw).filter(r=>!('e' in r.ref && excluded.has(r.ref.e)) && (!q.from || Date.parse(r.date)>=Date.parse(q.from)) && (!q.to || Date.parse(r.date)<Date.parse(q.to)));
    records.sort((a,b)=>(Date.parse(a.date)-Date.parse(b.date))*(q.sort==='oldest'?1:-1)||textCompare(encode(a.ref),encode(b.ref)));
    const state=hash(stableJson(records.map(r=>[encode(r.ref),r.date,r.folders.map(b=>b.id).sort()])));
    if(page && page.state!==state)fail('STALE_CURSOR','Mail search changed; restart without its cursor');
    const offset=page?.position||0;if(offset>records.length)fail('INVALID_CURSOR','IMAP page is outside the search results');
    if(!this.stableIds())warnings.push('This server has no account-wide message IDs; copies in different folders remain separate and moved messages need a new reference.');
    return {messages:records.slice(offset,offset+q.limit).map(summary),position:offset,queryState:state,total:records.length,warnings};
  }
  private async locate(id:string,boxes:Folder[]):Promise<Candidate>{
    const ref=decode(id);
    if('e' in ref){
      if(!this.stableIds())fail('STALE_RECORD','Server no longer supports the saved stable message ID');
      const found=this.merge(await this.collect(boxes,{emailId:ref.e}));
      const match=found.find(c=>c.message.emailId===ref.e);if(!match)fail('NOT_FOUND','Email is absent from the configured folders');return match;
    }
    const box=boxes.find(b=>b.id===ref.f);if(!box)fail('SOURCE_RESTRICTED','Saved mailbox is unavailable or outside configured folders');
    return this.inBox(box,async validity=>{
      if(validity!==ref.v)fail('STALE_RECORD','Mailbox identity changed; search again for a current reference');
      const message=await this.client.fetchOne(ref.u,{uid:true,envelope:true,internalDate:true,size:true,threadId:true},{uid:true});
      if(!message || message.uid!==ref.u)fail('NOT_FOUND','Email was removed or moved; search again for its current reference');
      return {ref,message,folder:box,folders:[box],validity,date:receivedAt(message)};
    });
  }
  private async detail(row:Candidate):Promise<MailDetail>{
    return this.inBox(row.folder,async validity=>{
      if(validity!==row.validity)fail('STALE_RECORD','Mailbox identity changed during the read');
      const message=await this.client.fetchOne(row.message.uid,{uid:true,bodyStructure:true},{uid:true});
      if(!message || message.uid!==row.message.uid || ('e' in row.ref && message.emailId!==row.ref.e))fail('NOT_FOUND','Email changed during the read');
      const structure=message.bodyStructure;if(!structure)fail('INVALID_PROVIDER_RESPONSE','IMAP returned no MIME structure');
      const parts=textParts(structure),bodies:string[]=[];let total=0;
      if(parts.length>100)fail('OUTPUT_LIMIT','Email has too many text parts');
      for(const part of parts){
        if((part.size||0)+total>this.settings.maxMessageBytes)fail('OUTPUT_LIMIT','Email text exceeds maxMessageBytes');
        const key=part.part||'TEXT';
        const fetched=await this.client.fetchOne(row.message.uid,{uid:true,bodyParts:[{key,start:0,maxLength:this.settings.maxMessageBytes-total+1}]},{uid:true});
        const bytes=fetched && fetched.bodyParts?.get(key);if(!bytes)fail('NOT_FOUND','Email text part is unavailable');
        total+=bytes.length;if(total>this.settings.maxMessageBytes)fail('OUTPUT_LIMIT','Email text exceeds maxMessageBytes');
        // Let mailparser decode transfer encodings, charsets, flowed text and HTML.
        const parameters=Object.entries(part.parameters||{}).filter(([k,v])=>/^[a-z0-9-]+$/i.test(k)&&!/[\r\n]/.test(v)).map(([k,v])=>`; ${k}=${JSON.stringify(v)}`).join('');
        const encoding=/^[a-z0-9-]+$/i.test(part.encoding||'')?part.encoding:'7bit';
        const headers=`Content-Type: ${part.type}${parameters}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`;
        bodies.push((await parseMimeMessage(Buffer.concat([Buffer.from(headers),bytes]))).bodyText);
      }
      return {summary:summary(row),body_text:bodies.join('\n\n'),attachments:leaves(structure).filter(p=>p.disposition==='attachment'||p.dispositionParameters?.filename||p.parameters?.name).map(p=>({filename:p.dispositionParameters?.filename||p.parameters?.name||'attachment.bin',mime_type:p.type})),warnings:[]};
    });
  }
  async read(id:string){return this.detail(await this.locate(id,this.allowed(await this.boxes())));}
  async thread(id:string,selectedId:string){
    if(!this.stableIds())return {messages:[],warnings:['This IMAP server does not provide thread IDs; open individual messages.']};
    const records=this.merge(await this.collect(this.allowed(await this.boxes()),{threadId:id}));
    records.sort((a,b)=>textCompare(a.date,b.date)||textCompare(encode(a.ref),encode(b.ref)));
    const index=records.findIndex(r=>encode(r.ref)===selectedId);if(index<0)fail('PARTIAL_CONTEXT','Selected email is absent from its thread');
    const selected=records.slice(Math.max(0,index-5),index+6),messages:MailDetail[]=[];
    for(const r of selected)messages.push(await this.detail(r));
    return {messages,warnings:['Context shows up to five neighbors on each side within configured folders.']};
  }
}

export function imapConnector(settings:ImapSettings,create:(options:ImapFlowOptions)=>ImapFlow=options=>new ImapFlow(options)):MailConnector{
  async function use<T>(fn:(s:Session)=>Promise<T>){
    const auth=settings.auth;
    const secret=await readSecret(auth.type==='password'?auth.password:auth.accessToken);
    const client=create({host:settings.host,port:settings.port,secure:settings.security==='tls',...(settings.security==='starttls'?{doSTARTTLS:true}:{}),auth:{user:settings.username,...(auth.type==='password'?{pass:secret}:{accessToken:secret})},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',...(settings.caFile?{ca:await readFile(settings.caFile,'utf8')}:{})},logger:false,disableAutoIdle:true,disableCompression:true,disableBinary:true,connectionTimeout:settings.timeoutMs,greetingTimeout:settings.timeoutMs,socketTimeout:settings.timeoutMs,maxLineLength:2*1024*1024,maxLiteralSize:settings.maxMessageBytes+1,maxResponseSize:settings.maxMessageBytes+1024*1024,maxResponseTokens:100000});
    client.on('error',()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([
      (async()=>{await client.connect();return fn(new Session(client,settings));})(),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{client.close();reject(Object.assign(new Error('IMAP request timed out'),{code:'TIMEOUT'}));},settings.timeoutMs);}),
    ]);}catch(e){
      const code=(e as any)?.code;
      if(['INVALID_REFERENCE','INVALID_PROVIDER_RESPONSE','SOURCE_RESTRICTED','STALE_RECORD','STALE_CURSOR','NOT_FOUND','PARTIAL_CONTEXT','OUTPUT_LIMIT','INVALID_CURSOR','INVALID_QUERY','SEARCH_TOO_BROAD','UNKNOWN_FOLDER','TIMEOUT'].includes(code))throw e;
      if((e as any)?.authenticationFailed)fail('AUTHENTICATION_FAILED','IMAP authentication failed; check credentials or refresh the access token');
      fail('MAIL_CONNECTION_FAILED','IMAP request failed; check server, TLS, account access and supported search features');
    }finally{clearTimeout(timer);client.close();}
  }
  return {status:()=>use(s=>s.status()),search:(q,p)=>use(s=>s.search(q,p)),read:id=>use(s=>s.read(id)),thread:(id,selected)=>use(s=>s.thread(id,selected))};
}
