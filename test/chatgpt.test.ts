import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,readFile,chmod,utimes,stat,truncate} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {defaultConfig} from './helpers/config';
import {createRuntime} from '../src/runtime';
import {rebuildArchive,indexStatus} from '../src/archive';
import {describeSource} from '../src/catalogue';
import {chatGptGroups} from '../src/chatgpt';
import {assertPacket} from '../src/shared';
import {archiveSignature} from '../src/exports';
import {createZip} from './helpers/zip';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const id='00000000-0000-4000-8000-000000000001';
const message=(id:string,role:string,content:any,time:number|null=1704067200)=>({id,author:{role},create_time:time,content});
const text=(body:string)=>({content_type:'text',parts:[body]});
const fixture={id,title:'Fixture history',current_node:'answer',mapping:{
 root:{id:'root',parent:null,children:['question'],message:null},
 question:{id:'question',parent:'root',children:['thought','alternate'],message:message('mq','user',text('Fixture question'))},
 thought:{id:'thought',parent:'question',children:['answer'],message:message('mt','assistant',{content_type:'thoughts',thoughts:[{text:'Fixture internal artifact'}]})},
 answer:{id:'answer',parent:'thought',children:[],message:message('ma','assistant',text('Fixture final answer'))},
 alternate:{id:'alternate',parent:'question',children:[],message:message('mb','assistant',text('Fixture alternate answer'))}
}};
test('ChatGPT role/content/branch filters, branch context and original-shard reads work through MCP',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chatgpt-ux-'));let client:Client|undefined;
 try{
  const things=join(root,'things');await mkdir(things);for(const [name,body] of Object.entries({'tasks.jsonl':'','context.json':'{"TMTask":[]}','snapshot-info.json':'{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}'}))await writeFile(join(things,name),body);
  const zip=join(root,'chatgpt.zip'),config={...defaultConfig(),things,index:join(root,'index.sqlite'),chatgpt:[zip]};
  const image={id:'00000000-0000-4000-8000-000000000002',title:'Fixture image',current_node:'image',mapping:{root:{id:'root',parent:null,children:['image'],message:null},image:{id:'image',parent:'root',children:[],message:message('mi','user',{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'file-service://fixture-private-pointer'}]})}}};
  const budget:any={id:'budget',title:'Budget context',current_node:'n11',mapping:{root:{id:'root',parent:null,children:['n0'],message:null}}};
  for(let i=0;i<12;i++)budget.mapping['n'+i]={id:'n'+i,parent:i ? 'n'+(i-1) : 'root',children:i<11 ? ['n'+(i+1)] : [],message:message('budget'+i,'user',text('界'.repeat(15000)))};
  const group={chats:[{id:'group-fixture',name:'Group context',messages:[{id:'last',role:'user',text:'Group late',created_at:'2024-01-03T00:00:00Z'},{id:'first',role:'user',text:'Group early',created_at:'2024-01-01T00:00:00Z'},{id:'middle',role:'assistant',text:'Group middle',created_at:'2024-01-02T00:00:00Z'}]}]};
  const bytes=await createZip([{path:'conversations-000.json',text:JSON.stringify([fixture])},{path:'conversations-001.json',text:JSON.stringify([image])},{path:'conversations-002.json',text:JSON.stringify([budget])},{path:'group_chats.json',text:JSON.stringify(group)}]);await writeFile(zip,bytes);await rebuildArchive(config);
  const state=JSON.parse((await indexStatus(config))['chatgpt-archive']),description=describeSource(config,{source:'chatgpt-archive',available:true,index:state});
  expect(description.capabilities.context).toBe(true);expect(description.capabilities.roles).toEqual(['assistant','user']);expect(description.conversations).toEqual({total:4,withMessages:4,empty:0});
  const runtime=createRuntime(config),search=async(q:any)=>(await runtime.search_sources({queries:[{source:'chatgpt-archive',query:'fixture',...q}]})).results[0];
  expect('types' in description.example && description.example.types).toEqual(['chatgpt-message']);
  expect((await runtime.search_sources({queries:[description.example]})).results[0].items.length).toBeGreaterThan(0);
  const bounded=(await search({query:'界',limit:25})).items.find(r=>r.metadata?.nodeId === 'n6')!;
  const boundedRead=await runtime.read_record({ref:bounded.ref,context:true});assertPacket(boundedRead);expect(boundedRead.context.length).toBeLessThan(10);expect(boundedRead.contextWarnings.some(w=>w.includes('budget'))).toBe(true);
  const continuation=await runtime.read_record({ref:bounded.ref,cursor:boundedRead.record.nextCursor,context:true});expect(continuation.context).toHaveLength(0);expect(continuation.record.body).toBe('界'.repeat(5000));
  const groupHit=(await search({query:'Group middle',types:['chatgpt-group-message']})).items[0];const groupRead=await runtime.read_record({ref:groupHit.ref,context:true});expect(groupRead.context.map((r:any)=>r.excerpt)).toEqual(['Group early','Group late']);expect(groupRead.contextWarnings[0]).toContain('sender');
  expect((await search({query:'Group',types:['chatgpt-group-message'],selectedBranch:true})).totalMatches).toBe(0);
  expect(()=>chatGptGroups({chats:[{id:'bad',messages:[{id:'x',role:'user',created_at:'2024-01-01'}]}]},zip,'group_chats.json',0)).toThrow();
  const own=await search({roles:['user'],contentTypes:['text'],selectedBranch:true});expect(own.totalMatches).toBe(1);expect(own.items[0].author).toBe('user');expect(own.query?.roles).toEqual(['user']);
  const final=await search({roles:['assistant'],contentTypes:['text'],selectedBranch:true});expect(final.totalMatches).toBe(1);expect(final.items[0].excerpt).toContain('final answer');expect(final.items[0].metadata?.openLink).toBe('https://chatgpt.com/c/'+id);
  const alternate=await search({selectedBranch:false});expect(alternate.totalMatches).toBe(1);expect(alternate.items[0].metadata?.selectedBranch).toBe(false);
  expect((await search({roles:['not-in-export']})).error?.code).toBe('TYPE_NOT_AVAILABLE');
  expect((await runtime.search_sources({queries:[{source:'journals',query:'fixture',selectedBranch:true}]})).results[0].error?.code).toBe('UNSUPPORTED_FILTER');
  const withContext=await runtime.read_record({ref:own.items[0].ref,context:true});expect(withContext.context.map((r:any)=>r.metadata.contentType)).toEqual(['thoughts','text']);expect(JSON.stringify(withContext.context)).not.toContain('alternate answer');
  const alternateContext=await runtime.read_record({ref:alternate.items[0].ref,context:true});expect((alternateContext.context[0] as any).author).toBe('user');expect(alternateContext.context).toHaveLength(1);
  const media=(await search({contentTypes:['multimodal_text']})).items[0];const read=await runtime.read_record({ref:media.ref});expect(read.record.body).toBe('');expect(read.record.warnings?.some(w=>w.includes('no exported text'))).toBe(true);expect(read.record.metadata?.originalContent).toBeUndefined();expect((await runtime.read_record({ref:media.ref,details:true})).record.metadata?.originalContent).toBeDefined();
  expect((await search({query:'fixture-private-pointer'})).totalMatches).toBe(0);
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config));client=new Client({name:'chatgpt-ux-fixture',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:configPath},stderr:'pipe'}));
  const packet=await client.callTool({name:'search_sources',arguments:{queries:[{source:'chatgpt-archive',query:'fixture',roles:['assistant'],contentTypes:['text'],selectedBranch:true}]}});expect(packet.isError).not.toBe(true);const hit=JSON.parse((packet.content as any[])[0].text).results[0].items[0];
  const opened=await client.callTool({name:'read_record',arguments:{ref:hit.ref,context:true}});expect(JSON.parse((opened.content as any[])[0].text).context).toHaveLength(2);
  expect(await readFile(zip)).toEqual(Buffer.from(bytes));
  await chmod(zip,0o600);expect((await search({roles:['user']})).status).not.toBe('error');
  const huge=join(root,'oversized.zip');await writeFile(huge,'');await truncate(huge,3*1024*1024*1024);await expect(archiveSignature({...config,chatgpt:[huge]},'chatgpt-archive')).rejects.toThrow('byte budget');
  await client.close();client=undefined;
  const directory=join(root,'folder');await mkdir(directory);const groupFile=join(directory,'group_chats.json');await writeFile(groupFile,JSON.stringify(group));const folderConfig={...config,index:join(root,'folder-index.sqlite'),chatgpt:[directory]};await rebuildArchive(folderConfig);const old=await stat(groupFile);await writeFile(groupFile,JSON.stringify(group).replace('Group late','Group edit'));await utimes(groupFile,old.atime,old.mtime);expect((await createRuntime(folderConfig).search_sources({queries:[{source:'chatgpt-archive',query:'Group'}]})).results[0].error?.code).toBe('INDEX_STALE');
  // An indexed locator lets one original shard stay readable when an unrelated shard changes; full rebuild still rejects the broken export.
  await writeFile(zip,await createZip([{path:'conversations-000.json',text:JSON.stringify([fixture])},{path:'conversations-001.json',text:'invalid JSON'}]));
  expect((await runtime.read_record({ref:final.items[0].ref})).record.body).toContain('final answer');await expect(rebuildArchive(config)).rejects.toThrow();
 }finally{await client?.close();await rm(root,{recursive:true,force:true});}
});
