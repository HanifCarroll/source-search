import { z } from 'zod';
import type { Config } from '../../platform/config';
import { fail, now, queryKey, position, cursor } from '../../domain/identity';
import type { Query, Ref, RecordData, Page } from '../../domain/contracts';
import { hit } from '../../domain/results';
import { AgentsViewClient, type AgentsViewFetch, type AgentMessage } from './client';

export async function agentHistoryStatus(c:Config, fetcher?:AgentsViewFetch) {
  const result=await new AgentsViewClient(c,fetcher).version();
  return {available:true,checkedAt:now(),health:result.data,server:c.agentsviewServer,warnings:result.warnings,
    coverage:'AgentsView coding-agent session index',
    querySyntax:'AgentsView FTS syntax; lexical uses fts. Hybrid (default) and semantic fall back to lexical with a warning.',
    filters:['from','to']};
}
const identitySchema=z.object({session:z.string().min(1).max(2000),ordinal:z.number().int().safe().nonnegative()}).strict();
function reference(source:string,session:string,ordinal:number,version?:string):Ref {
  return {source,id:'agentsview:'+Buffer.from(JSON.stringify({session,ordinal})).toString('base64url'),...(version?{version}:{})};
}
function identity(ref:Ref) {
  try {
    if(!ref.id.startsWith('agentsview:'))throw Error();
    return identitySchema.parse(JSON.parse(Buffer.from(ref.id.slice(11),'base64url').toString()));
  } catch { return fail('INVALID_REFERENCE','Invalid or legacy agent-history reference. Search again to get an AgentsView session/message reference.'); }
}
const locator=(source:string,session:string,ordinal:number)=>`source-search://${source}/${encodeURIComponent(session)}#message=${ordinal}`;
const date=(value:string,timeZone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export async function searchAgentHistory(c:Config, input:Query, fetcher?:AgentsViewFetch):Promise<Page> {
  const q={...input,mode:input.mode??'hybrid'};
  if(q.conversation)fail('UNSUPPORTED_FILTER','Agent history does not accept conversation filters here');
  const token=position(q.cursor,queryKey(q))??0;
  if(typeof token!=='number' || !Number.isSafeInteger(token) || token<0)fail('INVALID_CURSOR','Expected an AgentsView integer continuation');
  const result=await new AgentsViewClient(c,fetcher).search({pattern:q.query,mode:'fts',limit:q.limit,cursor:token,
    date_from:q.from?date(q.from,c.timeZone):undefined,
    date_to:q.to?date(new Date(Date.parse(q.to)-1).toISOString(),c.timeZone):undefined,
    timezone:c.timeZone,include_children:'true',include_automated:'true',include_one_shot:'true'});
  const data=result.data,warnings=[...result.warnings];
  const fallbackReason=q.mode==='lexical'?undefined:'AgentsView semantic search is unavailable on this backend; using fts.';
  if(fallbackReason)warnings.push(`Requested ${q.mode}; AgentsView used lexical: ${fallbackReason}`);
  if(data.coverage.status!=='ready')warnings.push(`AgentsView coverage is ${data.coverage.status.slice(0,100)} (lexical: ${data.coverage.lexical.status.slice(0,100)}; semantic: ${data.coverage.semantic.status.slice(0,100)}).`);
  if(!data.revision_bound)fail('SOURCE_NOT_READY','AgentsView search cannot provide revision-bound references.');
  if(data.matches.length>q.limit)fail('UNSUPPORTED_SCHEMA','AgentsView returned more matches than requested.');
  if(data.next_cursor && data.next_cursor<=token)fail('INVALID_CURSOR','AgentsView returned a non-advancing continuation.');
  if(q.from||q.to)warnings.push('AgentsView from/to filters select sessions active on calendar dates in the configured timezone; they do not filter individual message timestamps.');
  warnings.push('AgentsView reads return bounded message context; tool calls are summarized.');
  return {source:q.source,status:fallbackReason||data.coverage.lexical.status!=='ready'||data.coverage.status!=='ready'||result.warnings.length?'partial':'ok',
    retrieval:{requestedMode:q.mode,effectiveMode:'lexical',...(fallbackReason?{fallbackReason}:{})},
    items:data.matches.map(m=>hit({ref:reference(q.source,m.session_id,m.ordinal,m.transcript_revision),
      title:(m.display_name||`${m.project} · ${m.agent} (${m.machine})`).slice(0,300),body:m.snippet.slice(0,10000),
      type:'agent-conversation-hit',author:m.agent,conversation:m.session_id,observedAt:now(),
      locator:locator(q.source,m.session_id,m.ordinal),
      ...(m.timestamp&&Number.isFinite(Date.parse(m.timestamp))?{occurredAt:new Date(m.timestamp).toISOString()}:{}),
      metadata:{previewOnly:true,provenance:{sessionId:m.session_id,ordinal:m.ordinal,revision:m.transcript_revision,
        project:m.project,agent:m.agent,machine:m.machine,role:m.role,location:m.location,ordinalRange:m.ordinal_range}}},q,'retry-smaller-page')),
    ...(data.next_cursor?{nextCursor:cursor(queryKey(q),data.next_cursor)}:{}),warnings,observedAt:now()};
}
function formatMessage(message:AgentMessage) {
  const tools=message.tool_calls||[];
  const parts=[`${message.role}: ${message.content}`];
  if(message.thinking_text)parts.push('Thinking: '+message.thinking_text.slice(0,10000));
  if(tools.length)parts.push('Tools: '+tools.slice(0,20).map(t=>`${t.tool_name.slice(0,100)}${t.category?' ('+t.category.slice(0,100)+')':''}${t.input_json?' [input: '+t.input_json.slice(0,500)+(t.input_json.length>500?'…':'')+']':''}${t.result_content?' [result: '+t.result_content.slice(0,1000)+(t.result_content.length>1000?'…':'')+']':''}`).join('; ')+(tools.length>20?`; ${tools.length-20} more`:''));
  else if(message.has_tool_use)parts.push('Tools: used (details unavailable)');
  const body=parts.join('\n');
  return `${message.ordinal}: ${body.length>10000?body.slice(0,9970)+'\n[message truncated]':body}`;
}
export async function readAgentHistory(c:Config, ref:Ref, context:boolean, fetcher?:AgentsViewFetch):Promise<RecordData> {
  const selected=identity(ref),client=new AgentsViewClient(c,fetcher);
  const session=await client.session(selected.session),s=session.data;
  if(s.id!==selected.session)fail('UNSUPPORTED_SCHEMA','AgentsView returned a different session.');
  if(ref.version && ref.version!==s.transcript_revision)fail('STALE_RECORD','AgentsView transcript changed; search again for its current reference.');
  const version=ref.version||s.transcript_revision,window=context?5:0;
  const result=await client.messages(selected.session,selected.ordinal,window,version),messages=result.data.messages;
  if(result.data.transcript_revision!==version)fail('STALE_RECORD','AgentsView transcript changed; search again for its current reference.');
  if(!messages.some(m=>m.ordinal===selected.ordinal))fail('STALE_RECORD','AgentsView message is no longer available; search again.');
  if(messages.length>2*window+1 || messages.filter(m=>m.ordinal<selected.ordinal).length>window || messages.filter(m=>m.ordinal>selected.ordinal).length>window || messages.some((m,i)=>i>0&&m.ordinal<=messages[i-1]!.ordinal))fail('UNSUPPORTED_SCHEMA','AgentsView returned an invalid message window.');
  return {ref:{...ref,version},title:(s.display_name||s.first_message||`${s.project} · ${s.agent} (${s.machine})`).slice(0,300),
    body:messages.map(formatMessage).join('\n'),type:'agent-conversation-context',author:s.agent,conversation:s.id,
    observedAt:now(),locator:locator(ref.source,s.id,selected.ordinal),
    ...(s.started_at&&Number.isFinite(Date.parse(s.started_at))?{occurredAt:new Date(s.started_at).toISOString()}:{}),
    metadata:{provenance:{sessionId:s.id,ordinal:selected.ordinal,revision:version,project:s.project,agent:s.agent,machine:s.machine},
      cwd:s.cwd?.slice(0,2000),gitBranch:s.git_branch?.slice(0,500),startedAt:s.started_at,endedAt:s.ended_at,
      totalLines:s.message_count,returnedLines:messages.length},
    warnings:[...new Set([...session.warnings,...result.warnings]),'Bounded AgentsView context; numbers identify message ordinals. Each message is capped at 10,000 characters and tool calls are summarized.']};
}
