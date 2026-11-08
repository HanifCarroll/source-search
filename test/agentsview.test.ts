import {test,expect,spyOn} from 'bun:test';
import {writeFile,rm} from 'node:fs/promises';
import {agentsviewFixture} from './helpers/agentsview';
import {AgentsViewClient,type AgentsViewFetch} from '../src/sources/agent-history/client';
import {searchAgentHistory,readAgentHistory,agentHistoryStatus} from '../src/sources/agent-history';
import {querySchema} from '../src/domain/contracts';
import {cursor,queryKey,position,errorData} from '../src/domain/identity';
import {configSchema,sourceConfig,evidenceScope,sourceScope} from '../src/platform/config';
import {describeSource} from '../src/application/catalogue';
import {createRuntime} from '../src/application/runtime';
import {agentHistory} from '../src/maintenance/direct/indexes';
import {doctor} from '../src/interfaces/setup';
import {defaultConfig} from './helpers/config';

const query=()=>querySchema.parse({source:'agent-history',query:'fixture build',mode:'lexical',limit:1});

test('AgentsView maps search attribution, integer continuation, flags and timezone dates',async()=>{
 const f=await agentsviewFixture();try{
  f.search.next_cursor=2;
  const q={...query(),from:'2026-01-02T03:00:00Z',to:'2026-01-04T03:00:00Z'};
  const first=await searchAgentHistory(f.c,q,f.fetcher),h=first.items[0]!;
  expect(h.ref.version).toBe('7');expect(h.author).toBe('codex');expect(h.conversation).toBe(f.session.id);
  expect(h.locator).toContain(encodeURIComponent(f.session.id));expect(h.match.explanation).toContain('preview');expect(h.focus).toBeUndefined();
  const params=f.calls[0]!.url.searchParams;
  expect(Object.fromEntries(params)).toEqual({pattern:q.query,mode:'fts',limit:'1',cursor:'0',date_from:'2026-01-02',date_to:'2026-01-03',timezone:f.c.timeZone,include_children:'true',include_automated:'true',include_one_shot:'true'});
  expect(position(first.nextCursor,queryKey(q))).toBe(2);
  f.search.next_cursor=0;
  expect((await searchAgentHistory(f.c,{...q,cursor:first.nextCursor},f.fetcher)).nextCursor).toBeUndefined();
  expect(f.calls[1]!.url.searchParams.get('cursor')).toBe('2');
  expect(f.calls.every(c=>c.init.method==='GET')).toBe(true);
  await expect(searchAgentHistory(f.c,{...q,query:'different',cursor:first.nextCursor},f.fetcher)).rejects.toMatchObject({code:'INVALID_CURSOR'});
  for(const value of ['old-provider',-1,1.5])await expect(searchAgentHistory(f.c,{...q,cursor:cursor(queryKey(q),value)},f.fetcher)).rejects.toMatchObject({code:'INVALID_CURSOR'});
 }finally{await f.cleanup();}
});

test('AgentsView hybrid/default/semantic requests use semantic search with the intent header',async()=>{
 const f=await agentsviewFixture();try{
  f.search.coverage={status:'ready',lexical:{status:'ready'},semantic:{status:'ready',reason:null,embedded:10,missing:0}} as any;
  (f.search.matches[0] as any).score=0.82;(f.search.matches[0] as any).subordinate=true;
  for(const mode of [undefined,'hybrid','semantic'] as const){
   f.calls.length=0;
   const page=await searchAgentHistory(f.c,{...query(),mode},f.fetcher);
   expect(page.retrieval).toMatchObject({requestedMode:mode||'hybrid',effectiveMode:mode||'hybrid'});
   expect(page.retrieval?.fallbackReason).toBeUndefined();expect(page.status).toBe('ok');
   const call=f.calls[0]!,params=call.url.searchParams;
   expect(params.get('mode')).toBe(mode||'hybrid');expect(params.get('scope')).toBe('all');
   expect(params.has('cursor')).toBe(false);expect(params.has('include_children')).toBe(false);
   expect((call.init.headers as Record<string,string>)['X-AgentsView-Search-Intent']).toBe('semantic');
   expect(page.items[0]!.conversation).toBe(f.session.id);expect(page.nextCursor).toBeUndefined();
  }
  f.calls.length=0;
  const lexical=await searchAgentHistory(f.c,query(),f.fetcher);
  expect(lexical.status).toBe('ok');expect(lexical.retrieval).toMatchObject({requestedMode:'lexical',effectiveMode:'lexical'});
  expect(f.calls[0]!.url.searchParams.get('mode')).toBe('fts');
  expect((f.calls[0]!.init.headers as Record<string,string>)['X-AgentsView-Search-Intent']).toBeUndefined();
 }finally{await f.cleanup();}
});

test('AgentsView semantic unavailability (501) falls back to lexical and keeps fallback continuations lexical',async()=>{
 const f=await agentsviewFixture();try{
  const fetcher:AgentsViewFetch=async(input,init)=>{
   const url=new URL(input);
   if(url.pathname.endsWith('/search/content')&&url.searchParams.get('mode')!=='fts'){f.calls.push({url,init});
    return Response.json({error:'semantic search not available: index is building: 40% complete '+f.token},{status:501});}
   return f.fetcher(input,init);
  };
  f.search.next_cursor=2;
  for(const mode of [undefined,'hybrid','semantic'] as const){
   f.calls.length=0;
   const page=await searchAgentHistory(f.c,{...query(),mode},fetcher);
   expect(page.retrieval).toMatchObject({requestedMode:mode||'hybrid',effectiveMode:'lexical'});
   expect(page.retrieval?.fallbackReason).toContain('index is building');expect(page.status).toBe('partial');
   expect(page.warnings.join(' ')).toContain('AgentsView used lexical');
   expect(JSON.stringify(page)).not.toContain(f.token);
   expect(f.calls.map(c=>c.url.searchParams.get('mode'))).toEqual([mode||'hybrid','fts']);
   f.calls.length=0;f.search.next_cursor=0;
   const next=await searchAgentHistory(f.c,{...query(),mode,cursor:page.nextCursor},fetcher);f.search.next_cursor=2;
   expect(next.retrieval).toMatchObject({effectiveMode:'lexical'});
   expect(f.calls.map(c=>c.url.searchParams.get('mode'))).toEqual(['fts']);expect(f.calls[0]!.url.searchParams.get('cursor')).toBe('2');
  }
 }finally{await f.cleanup();}
});

test('AgentsView stable references read bounded context with tools and expected revision, independent of search',async()=>{
 const f=await agentsviewFixture();try{
  const ref=(await searchAgentHistory(f.c,query(),f.fetcher)).items[0]!.ref;
  const compact=await readAgentHistory(f.c,ref,false,f.fetcher);expect(compact.body).toBe('6: assistant: Invented message 6');
  expect(compact.title).toBe(f.session.display_name);expect(compact.metadata?.provenance).toMatchObject({sessionId:f.session.id,machine:'pro',revision:'7'});
  f.messages[0]!.content='A'.repeat(12000);Object.assign(f.messages[5]!,{thinking_text:'A synthetic thought',has_tool_use:true,tool_calls:[{tool_name:'terminal',category:'shell',input_json:'invented input',result_content:'invented output'}]});
  f.search.matches=[]; // Index/search changes cannot invalidate the session identity.
  const count=f.calls.length,wide=await readAgentHistory(f.c,ref,true,f.fetcher);
  expect(wide.metadata?.returnedLines).toBe(11);expect(wide.body).toContain('[message truncated]');expect(wide.body).toContain('Tools: terminal (shell)');expect(wide.body).toContain('Thinking: A synthetic thought');
  expect(wide.body).toContain('[result: invented output]');expect(wide.body.length).toBeLessThan(110100);
  const call=f.calls.at(-1)!;expect(call.url.pathname).toContain('pro~codex%3Ainvented-session/messages');
  expect(Object.fromEntries(call.url.searchParams)).toEqual({around:'6',before:'5',after:'5',expected_revision:'7'});
  expect(f.calls.slice(count).every(c=>!c.url.pathname.includes('/search'))).toBe(true);
  expect((await readAgentHistory(f.c,{...ref,version:undefined},false,f.fetcher)).ref.version).toBe('7');
  f.messages[0]!.ordinal=0;f.messages[10]!.ordinal=50;
  const gaps=await readAgentHistory(f.c,ref,true,f.fetcher);expect(gaps.body).toContain('50: user: Invented message 11');
 }finally{await f.cleanup();}
});

test('AgentsView rejects changed revisions, concurrent changes and missing anchor messages',async()=>{
 const f=await agentsviewFixture();try{
  const ref=(await searchAgentHistory(f.c,query(),f.fetcher)).items[0]!.ref;
  f.session.transcript_revision='8';await expect(readAgentHistory(f.c,ref,true,f.fetcher)).rejects.toMatchObject({code:'STALE_RECORD'});
  f.session.transcript_revision='7';
  const concurrent:AgentsViewFetch=(url,init)=>url.includes('/messages')?Promise.resolve(Response.json({code:'source_changed',detail:f.token},{status:409})):f.fetcher(url,init);
  await expect(readAgentHistory(f.c,ref,true,concurrent)).rejects.toMatchObject({code:'STALE_RECORD'});
  f.messages.splice(5,1);await expect(readAgentHistory(f.c,ref,false,f.fetcher)).rejects.toMatchObject({code:'STALE_RECORD'});
 }finally{await f.cleanup();}
});

test('legacy query-bound references fail before credentials or network access',async()=>{
 let requests=0;const fetcher:AgentsViewFetch=async()=>{requests++;throw Error();};
 for(const id of ['broken',Buffer.from(JSON.stringify({q:query(),result:1,fingerprint:'old'})).toString('base64url'),'agentsview:'+Buffer.from('{"session":"x","ordinal":-1}').toString('base64url')]){
  await expect(readAgentHistory(defaultConfig(),{source:'agent-history',id},false,fetcher)).rejects.toMatchObject({code:'INVALID_REFERENCE',message:expect.stringContaining('Search again')});
 }
 expect(requests).toBe(0);
});

test('AgentsView authentication, HTTP and network errors never expose bearer credentials',async()=>{
 const f=await agentsviewFixture();try{
  for(const status of [401,403,400,429,500,503]){
   const fetcher:AgentsViewFetch=async()=>Response.json({error:f.token},{status});
   let output:unknown;try{await searchAgentHistory(f.c,query(),fetcher);}catch(e){output=errorData(e);}
   expect(JSON.stringify(output)).not.toContain(f.token);
   expect(output).toMatchObject({code:status===401||status===403?'PERMISSION_DENIED':status>=500?'SOURCE_NOT_READY':'SOURCE_HTTP_ERROR'});
  }
  await expect(searchAgentHistory(f.c,query(),async()=>{throw new Error(f.token);})).rejects.toMatchObject({code:'SOURCE_NOT_READY'});
 }finally{await f.cleanup();}
});

test('AgentsView token reads trim and rotate on each request, redact success fields, and reject missing/empty credentials',async()=>{
 const f=await agentsviewFixture();try{
  const client=new AgentsViewClient(f.c,f.fetcher);await client.version();
  expect(new Headers(f.calls.at(-1)!.init.headers).get('Authorization')).toBe('Bearer '+f.token);
  await writeFile(f.tokenFile,'invented-rotated-token\n');await client.version();
  expect(new Headers(f.calls.at(-1)!.init.headers).get('Authorization')).toBe('Bearer invented-rotated-token');
  await writeFile(f.tokenFile,f.token);f.match.snippet=f.token;f.match.display_name=f.token;
  expect(JSON.stringify(await searchAgentHistory(f.c,query(),f.fetcher))).not.toContain(f.token);
  f.session.first_message=f.token;f.messages[5]!.content=f.token;
  const ref=(await searchAgentHistory(f.c,query(),f.fetcher)).items[0]!.ref;
  expect(JSON.stringify(await readAgentHistory(f.c,ref,true,f.fetcher))).not.toContain(f.token);
  for(const value of ['', 'bad\ncredential','x'.repeat(17000)]){await writeFile(f.tokenFile,value);await expect(client.version()).rejects.toMatchObject({code:'PERMISSION_DENIED'});}
  await rm(f.tokenFile);await expect(client.version()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 }finally{await f.cleanup();}
});

test('AgentsView enforces stream/header byte bounds, timeout and response schemas',async()=>{
 const f=await agentsviewFixture();try{
  const large:AgentsViewFetch=async()=>new Response('x'.repeat(101));
  await expect(new AgentsViewClient(f.c,large,1000,100).version()).rejects.toMatchObject({code:'SOURCE_LIMIT'});
  await expect(new AgentsViewClient(f.c,async()=>new Response('{}',{headers:{'content-length':'101'}}),1000,100).version()).rejects.toMatchObject({code:'SOURCE_LIMIT'});
  for(const body of ['not json',JSON.stringify({version:f.token}),JSON.stringify({...f.version,data_version:'bad'})])await expect(new AgentsViewClient(f.c,async()=>new Response(body)).version()).rejects.toMatchObject({code:'UNSUPPORTED_SCHEMA'});
  const hang:AgentsViewFetch=(_url,init)=>new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(Error(f.token)),{once:true}));
  await expect(new AgentsViewClient(f.c,hang,5).version()).rejects.toMatchObject({code:'SOURCE_NOT_READY'});
  const stream:AgentsViewFetch=async(_url,init)=>new Response(new ReadableStream({start(controller){init.signal!.addEventListener('abort',()=>controller.error(Error(f.token)),{once:true});}}));
  await expect(new AgentsViewClient(f.c,stream,5).version()).rejects.toMatchObject({code:'SOURCE_NOT_READY'});
  f.match.ordinal=-1;await expect(searchAgentHistory(f.c,query(),f.fetcher)).rejects.toMatchObject({code:'UNSUPPORTED_SCHEMA'});
 }finally{await f.cleanup();}
});

test('AgentsView stale archive headers propagate through status, search and read without maintenance',async()=>{
 const f=await agentsviewFixture();try{
  const fetcher:AgentsViewFetch=async(url,init)=>{const response=await f.fetcher(url,init);response.headers.set('X-Agentsview-Archive-Stale','true');return response;};
  const status=await agentHistoryStatus(f.c,fetcher);expect(status.available).toBe(true);expect(status.health).toEqual(f.version);expect(status.warnings.join(' ')).toContain('stale');
  const description=describeSource(f.c,{source:'agent-history',...status});expect(description.coverage).toBe('AgentsView coding-agent session index');expect(description.server).toBe(f.c.agentsviewServer);
  const page=await searchAgentHistory(f.c,query(),fetcher);expect(page.warnings.join(' ')).toContain('stale');
  const record=await readAgentHistory(f.c,page.items[0]!.ref,true,fetcher);expect(record.warnings?.join(' ')).toContain('stale');
  expect(f.calls.every(c=>c.init.method==='GET'&&c.init.redirect==='error')).toBe(true);
 }finally{await f.cleanup();}
});

test('AgentsView config validates URL/token paths, binds selected server and explains migration',()=>{
 const setting={adapter:'agent-history',server:'https://agentsview.example.test',tokenFile:'/invented/token'};
 const c=configSchema.parse({sources:{'agent-history':setting},enabledSources:['agent-history']});
 expect(sourceConfig(c,'agent-history').agentsviewServer).toBe(setting.server);
 expect(sourceConfig(c,'agent-history').agentsviewTokenFile).toBe(setting.tokenFile);
 for(const server of ['file:///invented','ftp://example.test','https://user:secret@example.test','https://example.test/?token=secret'])expect(()=>configSchema.parse({sources:{'agent-history':{...setting,server}}})).toThrow('http/https');
 expect(()=>configSchema.parse({sources:{'agent-history':{...setting,tokenFile:'relative'}}})).toThrow('absolute');
 expect(()=>configSchema.parse({sources:{'agent-history':{adapter:'agent-history',data:'/invented/old',binary:'/invented/old-bin'}}})).toThrow('Replace data/binary with server');
 const changed=configSchema.parse({sources:{'agent-history':{...setting,server:'https://other.example.test'}},enabledSources:['agent-history']});
 expect(evidenceScope(c,'agent-history')).not.toBe(evidenceScope(changed,'agent-history'));
 expect(sourceScope(c,'agent-history')).not.toBe(sourceScope(changed,'agent-history'));
 expect(Object.keys(c).some(k=>/cass/i.test(k))).toBe(false);
});

test('AgentsView runtime continuation retains context and source failures remain partial',async()=>{
 const f=await agentsviewFixture();const mock=spyOn(globalThis,'fetch').mockImplementation(f.fetcher as typeof fetch);
 try{
  f.messages[0]!.content='A'.repeat(10000);f.search.coverage.status='ready';
  const runtime=createRuntime(f.c),search=await runtime.search_sources({queries:[query()]}),ref=search.results[0]!.items[0]!.ref;
  const first=await runtime.read_record({ref,context:true});expect(first.record.nextCursor).toBeDefined();
  const bodies=[first.record.body];let token=first.record.nextCursor;
  while(token){const next=await runtime.read_record({ref,context:true,cursor:token});bodies.push(next.record.body);token=next.record.nextCursor;}
  expect(bodies.join('')).toContain('6: assistant: Invented message 6');
  await expect(runtime.read_record({ref,context:false,cursor:first.record.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  const report=await doctor(f.c);expect(report.checks.filter(c=>c.name.includes('AgentsView')).every(c=>c.available)).toBe(true);
  const mixed=await createRuntime({...f.c,enabledSources:['agent-history','journals'],journals:f.root}).search_sources({queries:[query(),{source:'journals',query:'invented'}]});
  expect(mixed.results[0]!.status).toBe('ok');expect(mixed.results).toHaveLength(2);
  const offline:AgentsViewFetch=async()=>{throw Error('Invented offline server');};mock.mockImplementation(offline as typeof fetch);
  const partial=await createRuntime({...f.c,enabledSources:['agent-history','journals'],journals:f.root}).search_sources({queries:[query(),{source:'journals',query:'invented'}]});
  expect(partial.results[0]!.error?.code).toBe('SOURCE_NOT_READY');expect(partial.results[1]!.status).toBe('ok');expect(partial.summary.failed).toEqual(['agent-history']);
  const disabled=createRuntime({...f.c,enabledSources:[]});
  await expect(disabled.read_record({ref,context:true})).rejects.toMatchObject({code:'SOURCE_DISABLED'});
 }finally{mock.mockRestore();await f.cleanup();}
});

test('AgentsView index tracking fails explicitly rather than claiming to track older session changes',async()=>{
 await expect(agentHistory(defaultConfig(),'agent-history',undefined)).rejects.toMatchObject({code:'UNSUPPORTED_CHANGE_TRACKING',message:expect.stringContaining('reset means rerun')});
});
