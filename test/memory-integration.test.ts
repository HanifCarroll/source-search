import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {configSchema} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {packetBytes} from '../src/domain/results';

async function cli(config:string,command:string,input?:unknown,home?:string){
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),command,...(typeof input==='string'?[input]:input===undefined?[]:[JSON.stringify(input)])],{env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:config,...(home?{HOME:home}:{})},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  return {code,data:JSON.parse(out||err)};
}

test('an independent installation uses memory through MCP and CLI, preserves it through cache cleanup and restores exports',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-continuity-'));let client:Client|undefined;
  try{
    const config=join(root,'config.json'),notes=join(root,'notes'),memoryRoot=join(root,'memory');
    await mkdir(notes);await writeFile(join(notes,'Test.md'),'# Optics\nThe invented optical test passed.');
    const settings={memoryRoot,timeZone:'Asia/Tokyo',maintenanceEnabled:true,enabledSources:['field-notes'],sources:{'field-notes':{adapter:'markdown',root:notes}}};
    await writeFile(config,JSON.stringify(settings));
    client=new Client({name:'memory-fixture',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:config,HOME:root},stderr:'pipe'}));
    const tools=(await client.listTools()).tools;
    expect(tools).toHaveLength(9);expect(tools.find(t=>t.name==='write_memory')!.annotations).toMatchObject({readOnlyHint:false,idempotentHint:true});
    expect(tools.find(t=>t.name==='list_changes')!.annotations!.readOnlyHint).toBe(true);
    async function call(name:string,args:Record<string,unknown>){const r=await client!.callTool({name,arguments:args});expect(r.isError).not.toBe(true);return JSON.parse((r.content as any[])[0].text);}
    const source=await call('search_sources',{queries:[{source:'field-notes',query:'optical'}]}),ref=source.results[0].items[0].ref;
    const input={operationId:randomUUID(),reason:'Invented verification',memory:{kind:'outcome',text:'Optical check passed',evidence:[{ref,quote:'The invented optical test passed.'}],verification:{method:'Read test result',observation:'Pass recorded',by:'Fixture'}}};
    const first=(await call('write_memory',input)).memory;
    expect((await cli(config,'remember',input,root)).data.data.replayed).toBe(true);
    expect((await call('read_memory',{id:first.id,checkEvidence:true})).evidenceChecks[0].status).toBe('current');
    const updates=await Promise.all(['left','right'].map(text=>cli(config,'remember',{operationId:randomUUID(),id:first.id,expectedRevision:1,reason:'Concurrent edit',memory:{kind:'outcome',text}},root)));
    expect(updates.filter(r=>r.code===0)).toHaveLength(1);expect(updates.find(r=>r.code!==0)!.data.error.code).toBe('REVISION_CONFLICT');
    expect((await cli(config,'rebuild',undefined,root)).code).toBe(0);
    expect((await cli(config,'purge-cache','--apply',root)).code).toBe(0);
    expect((await call('read_memory',{id:first.id})).memory.revision).toBe(2);
    const changes=await call('list_changes',{feed:'memory',limit:1});expect(changes.hasMore).toBe(true);
    expect((await cli(config,'changes',{feed:'memory',cursor:changes.cursor},root)).data.data.items[0].revision).toBe(2);
    const backup=join(root,'backup.json');expect((await cli(config,'memory-export',backup,root)).code).toBe(0);
    expect((await stat(backup)).mode&0o777).toBe(0o600);
    await writeFile(config,JSON.stringify({...settings,memoryRoot:join(root,'restored')}));
    expect((await cli(config,'memory-restore',backup,root)).code).toBe(0);
    expect((await call('read_memory',{id:first.id,revision:1})).memory.text).toBe('Optical check passed');
    expect((await cli(config,'memory-restore',backup,root)).data.error.code).toBe('MEMORY_NOT_EMPTY');
    const reset=await client.callTool({name:'list_changes',arguments:{feed:'memory',cursor:changes.cursor}});expect(reset.isError).toBe(true);expect(JSON.stringify(reset)).toContain('FEED_RESET');
    expect(await readFile(join(notes,'Test.md'),'utf8')).toBe('# Optics\nThe invented optical test passed.');
  }finally{await client?.close();await rm(root,{recursive:true,force:true});}
},30000);

test('large memory previews reduce pages without losing continuation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-memory-size-'));
  try{
    const entity='project-'+'a'.repeat(50),c=configSchema.parse({memoryRoot:root,contextEntities:{[entity]:{kind:'project',label:'Fixture'}}}),rt=createRuntime(c);
    for(let i=0;i<50;i++)await rt.write_memory({operationId:randomUUID(),reason:'Size fixture',memory:{kind:'decision',text:'\u{1f52d}'.repeat(300)+' '+i,entities:Array(12).fill(entity)}});
    const ids=new Set<string>();let cursor:string|undefined;
    do{const page=await rt.list_memories({limit:50,cursor});expect(packetBytes(page)).toBeLessThanOrEqual(48*1024);for(const r of page.items){expect(ids.has(r.id)).toBe(false);ids.add(r.id);}cursor=page.nextCursor;}while(cursor);
    expect(ids.size).toBe(50);
    const current=(await rt.list_memories({limit:1})).items[0]!;
    expect((await rt.read_memory({id:current.id})).memory.text).toContain('49');
  }finally{await rm(root,{recursive:true,force:true});}
});
