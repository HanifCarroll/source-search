import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from './config';
import type {AgentsViewFetch} from '../../src/sources/agent-history/client';

export async function agentsviewFixture() {
  const root=await mkdtemp(join(tmpdir(),'source-search-agentsview-')),tokenFile=join(root,'token');
  const token='invented-test-credential';await writeFile(tokenFile,'  '+token+'\n');
  const c={...defaultConfig(),enabledSources:['agent-history'],agentsviewServer:'http://agentsview.example.test',agentsviewTokenFile:tokenFile};
  const session={id:'pro~codex:invented-session',project:'fixture-app',machine:'pro',agent:'codex',first_message:'Fix the fixture build',
    display_name:'Fixture build',started_at:'2026-01-02T10:00:00Z',ended_at:'2026-01-02T11:00:00Z',message_count:12,
    cwd:'/invented/fixture-app',git_branch:'main',transcript_revision:'7'};
  const match={session_id:session.id,project:session.project,agent:session.agent,machine:session.machine,display_name:session.display_name,
    location:'tool_result:terminal',role:'assistant',ordinal:6,timestamp:'2026-01-02T10:30:00Z',snippet:'Fixture build error',
    ordinal_range:[5,6],transcript_revision:session.transcript_revision};
  const search={active_filter_applied:false,matches:[match],next_cursor:0,revision_bound:true,
    coverage:{status:'partial',lexical:{status:'ready'},semantic:{status:'unavailable',reason:'not_configured',embedded:0,missing:0}}};
  const version={version:'v0.46.1',api_version:12,data_version:143};
  const messages=Array.from({length:11},(_,i)=>({ordinal:i+1,role:i%2?'assistant':'user',content:'Invented message '+(i+1),
    thinking_text:'',timestamp:'2026-01-02T10:30:00Z',has_tool_use:false,tool_calls:[]}));
  const calls:{url:URL;init:RequestInit}[]=[];
  const fetcher:AgentsViewFetch=async(input,init)=>{
    const url=new URL(input);calls.push({url,init});let data:unknown;
    if(url.pathname.endsWith('/version'))data=version;
    else if(url.pathname.endsWith('/search/content'))data=search;
    else if(url.pathname.endsWith('/messages')) {
      const anchor=Number(url.searchParams.get('around')),before=Number(url.searchParams.get('before')),after=Number(url.searchParams.get('after'));
      const selected=[...messages.filter(m=>m.ordinal<anchor).slice(-before||messages.length),...messages.filter(m=>m.ordinal===anchor),...messages.filter(m=>m.ordinal>anchor).slice(0,after)];
      data={messages:selected,count:selected.length,transcript_revision:session.transcript_revision};
    } else data=session;
    return Response.json(data);
  };
  return {c,root,token,tokenFile,session,match,search,version,messages,calls,fetcher,cleanup:()=>rm(root,{recursive:true,force:true})};
}
