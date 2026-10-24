import {sourceKind} from '../../domain/source-catalog';
import {defaultConfig,mailAccount,requireSource,sourceScope,type Config} from '../../platform/config';
import {cursor,fail,now,position,queryKey,versioned} from '../../domain/identity';
import {readableMail} from '../../domain/presentation';
import {hit} from '../../domain/results';
import type {Page,Query,RecordData} from '../../domain/contracts';
import {jmapConnector} from './jmap';
import {imapConnector} from './imap';
import type {MailConnector,MailContinuation,MailDetail,MailSummary} from './types';
import * as legacy from './legacy';
export {run,type Run,type PreviewBudget,type MailSource} from './legacy';

function connector(config:Config,source:string):MailConnector|undefined{
  requireSource(config,source);
  const setting=config.sources[source];
  if(setting?.adapter==='jmap')return jmapConnector(setting);
  if(setting?.adapter==='imap')return imapConnector(setting);
}
export async function mailStatus(config:Config,source:string){return connector(config,source)?.status();}
function presentationAdapter(config:Config,source:string){const s=config.sources[source];return s?.adapter==='jmap' && s.recordFormat==='mailbridge-v1' && new URL(s.sessionUrl).hostname==='api.fastmail.com'?'fastmail':sourceKind(source,config);}
function metadata(summary:MailSummary,config:Config,source:string){
  return {dateKind:'provider-received-at',direction:summary.folders.some(f=>f.role==='sent')?'outgoing':'unknown',account:mailAccount(config,source)!.email,to:summary.to,cc:summary.cc,bodyFormat:'text',folders:summary.folders,labels:[],messageId:summary.messageId};
}
export function formatMail(source:string,raw:MailDetail,config:Config):RecordData{
  const s=raw.summary;
  return versioned({adapter:presentationAdapter(config,source),ref:{source,id:s.message_id},title:s.subject||'(No subject)',body:readableMail(raw.body_text||raw.body_html||''),type:'email',observedAt:now(),locator:`source-search://${source}/${s.message_id}`,author:s.from||'unknown',occurredAt:s.date?new Date(s.date).toISOString():undefined,conversation:s.thread_id||undefined,metadata:{...metadata(s,config,source),attachments:raw.attachments.map(a=>({name:a.filename,type:a.mime_type}))},warnings:raw.warnings||[]});
}
export async function searchMail(q:Query,execute:legacy.Run=legacy.run,previews:legacy.PreviewBudget={remaining:3,records:new Map()},config:Config=defaultConfig()):Promise<Page>{
  const backend=connector(config,q.source);if(!backend)return legacy.searchMail(q,execute,previews,config);
  if(q.conversation)fail('UNSUPPORTED_FILTER','Use read_record with context to open the mail thread');
  q={...q,excludeSpamTrash:q.excludeSpamTrash!==false};
  const key=queryKey(q),encoded=position(q.cursor,key),scope=sourceScope(config,q.source);
  let page:MailContinuation|undefined;
  if(encoded!==undefined){
    try{if(typeof encoded!=='string')throw Error();page=JSON.parse(encoded);if(!page || !Number.isSafeInteger(page.position) || page.position<1 || typeof page.state!=='string' || !page.state.length || page.state.length>1000)throw Error();}
    catch{fail('INVALID_CURSOR','Invalid mail continuation');}
    const setting=config.sources[q.source];
    if(!page.scope && !(setting?.adapter==='jmap' && setting.recordFormat==='mailbridge-v1'))fail('INVALID_CURSOR','Mail continuation is missing its account scope');
    if(page.scope && page.scope!==scope)fail('STALE_CURSOR','Mail account or folder configuration changed; restart the query');
  }
  const result=await backend.search(q,page),observedAt=now();
  const token=(position:number)=>JSON.stringify({position,state:result.queryState,scope});
  if(sourceKind(q.source,config)==='imap')for(const s of result.messages){
    const id=q.source+':'+s.message_id;
    if(previews.remaining>0 && !previews.records.has(id)){
      previews.remaining--;
      try{previews.records.set(id,formatMail(q.source,await backend.read(s.message_id),config));}
      catch{result.warnings.push('A message preview was unavailable; open its reference to retry.');}
    }
  }
  const items=result.messages.map((s,index)=>hit(previews.records.get(q.source+':'+s.message_id) || {adapter:presentationAdapter(config,q.source),ref:{source:q.source,id:s.message_id},title:s.subject||'(No subject)',body:s.snippet||'',type:'email',locator:`source-search://${q.source}/${s.message_id}`,observedAt,author:String(s.from||'unknown').slice(0,500),occurredAt:s.date?new Date(s.date).toISOString():undefined,conversation:s.thread_id||undefined,metadata:{previewOnly:true,dateKind:'provider-received-at',direction:metadata(s,config,q.source).direction,account:mailAccount(config,q.source)!.email,to:s.to,labels:[],folders:s.folders,messageId:s.messageId}},q,token(result.position+index+1)));
  const end=result.position+items.length;
  return {source:q.source,status:'ok',items,totalMatches:result.total,...(sourceKind(q.source,config)==='imap'?{query:{match:q.match||'words'}}:{}),...(end<result.total?{nextCursor:cursor(key,token(end))}:{}),observedAt,warnings:result.warnings};
}
export async function readMail(source:string,id:string,execute:legacy.Run=legacy.run,config:Config=defaultConfig(),capture?:(raw:unknown)=>void):Promise<RecordData>{
  const backend=connector(config,source);
  if(!backend)return legacy.readMail(source,id,async argv=>{const raw=await execute(argv);capture?.(raw);return raw;},config);
  const raw=await backend.read(id);capture?.(raw);return formatMail(source,raw,config);
}
export async function mailContext(record:RecordData,execute:legacy.Run=legacy.run,config:Config=defaultConfig()){
  const backend=connector(config,record.ref.source);if(!backend)return legacy.mailContext(record,execute,config);
  if(!record.conversation)return {records:[],warnings:['This server did not provide a thread identifier; open individual messages.']};
  const result=await backend.thread(record.conversation,record.ref.id);
  return {records:result.messages.filter(m=>m.summary.message_id!==record.ref.id).map(m=>({ref:{source:record.ref.source,id:m.summary.message_id},excerpt:readableMail(m.body_text||m.summary.snippet||'').slice(0,500),title:m.summary.subject})),warnings:result.warnings};
}
