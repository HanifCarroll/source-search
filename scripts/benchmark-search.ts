// Invented corpus only. Full mode uses already-installed local models; no
// accounts, source records, model downloads or network inference are involved.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {configSchema,loadConfig,sourceConfig} from '../src/platform/config';
import {runSdk,searchModels,disposeSearchWorkers} from '../src/search/qmd/runner';
import {packageRoot} from '../src/platform/package-root';
import type {Query} from '../src/domain/contracts';

process.umask(0o077);
const source='research';
const lexicalOnly=process.argv.includes('--lexical-only'),at=process.argv.indexOf('--models-from');
const settings=at>=0?configSchema.parse(JSON.parse(await readFile(resolve(process.argv[at+1]!), 'utf8'))):undefined;
const models=lexicalOnly?undefined:searchModels(settings||await loadConfig());
if(!lexicalOnly && !models)throw Error('Full benchmark needs installed searchModels; use --models-from /private/config.json or --lexical-only');
const root=await mkdtemp(join(tmpdir(),'source-search-benchmark-')),notes=join(root,'notes'),excluded=join(root,'excluded'),configPath=join(root,'config.json');
let client:Client|undefined;
const checks:{query:string;mode:string;coldMs:number;repeatMs:number;pageMs?:number;expectedRank:number}[]=[];
async function connect(){
  const next=new Client({name:'source-search-benchmark',version:'1'});
  await next.connect(new StdioClientTransport({command:process.execPath,args:[join(packageRoot,'src/mcp.ts')],cwd:root,env:{...Object.fromEntries(Object.entries(process.env).filter((v):v is [string,string]=>v[1]!==undefined)),SOURCE_SEARCH_CONFIG_FILE:configPath},stderr:'pipe'}));
  return next;
}
async function search(query:string,mode:string,limit=3,cursor?:string,options:Pick<Query,'plan'|'depth'>={}){
  const started=performance.now(),raw=await client!.callTool({name:'search_sources',arguments:{queries:[{source,query,mode,limit,...options,...(cursor?{cursor}:{})}]}},undefined,{timeout:120000});
  assert(!raw.isError,JSON.stringify(raw));
  const block=(raw.content as {type:string;text:string}[]).find(b=>b.type==='text');assert(block);
  const data=JSON.parse(block.text),page=data.results[0];assert.notEqual(page.status,'error',JSON.stringify(page.error));
  assert(page.items.every((i:any)=>i.ref.source===source&&i.ref.id.startsWith('qmd://notes/')),'Excluded collection leaked into results');
  return {page,ms:Math.round(performance.now()-started)};
}
try{
  await mkdir(notes);await mkdir(excluded);
  const documents:{[id:string]:string}={
    recovery:'# Access recovery\n\nEmployees who cannot sign in must contact the help desk. Support verifies their identity and resets the account password. The account lockout procedure restores access to the company system.',
    event:'# Conference planning\n\nThe annual company gathering was postponed until December. Notify attendees of the new date, reschedule the venue booking and update the event calendar.',
    exact:'# Equipment code\n\nThe cobaltimeter calibration reference is ZXQ731. Check the equipment calibration certificate before using the instrument.',
  };
  for(const [id,text] of Object.entries(documents))await writeFile(join(notes,id+'.md'),text);
  for(let i=0;i<256;i++)await writeFile(join(notes,`other-${i}.md`),`# Garden observation ${i}\n\nInvented field log ${i}. The gardener watered the seedlings and recorded leaf size and soil moisture. Plants grew in the morning sunlight.`);
  await writeFile(join(excluded,'private.md'),'# Excluded\n\nZXQ731 cobaltimeter locked out of my account rescheduling the company event.');
  const acceleration=settings?.searchAcceleration?{...settings.searchAcceleration,cache:join(root,'models')}:undefined;
  const c=configSchema.parse({enabledSources:[source],maintenanceEnabled:true,sources:{[source]:{adapter:'vault',database:join(root,'search.sqlite'),roots:{notes,excluded}}},...(models?{searchModels:models,searchAcceleration:acceleration,searchRanker:settings?.searchRanker}:{})});
  await runSdk(sourceConfig(c,source),{index:'vault',action:'update'});if(models)await runSdk(sourceConfig(c,source),{index:'vault',action:'embed'});
  // Same index, narrower source selection, via an actual bundled MCP gateway.
  const scoped=configSchema.parse({...c,sources:{[source]:{adapter:'vault',database:join(root,'search.sqlite'),roots:{notes}}}});await writeFile(configPath,JSON.stringify(scoped),{mode:0o600});client=await connect();
  const cases:({query:string;mode:string;expected:string}&Pick<Query,'plan'|'depth'>)[]=[{query:'cobaltimeter',mode:'lexical',expected:'exact'},...(!lexicalOnly?[
    {query:'locked out of my account',mode:'semantic',expected:'recovery'},
    {query:'rescheduling the company event',mode:'hybrid',expected:'event'},
    {query:'¿Cómo puedo recuperar el acceso a mi cuenta?',mode:'hybrid',expected:'recovery',plan:{lexical:['password reset'],semantic:['recover a locked account']}},
    {query:'Who can help when I forget my password?',mode:'hybrid',expected:'recovery',depth:'deep' as const},
  ]:[])];
  for(const c of cases){
    const options={plan:c.plan,depth:c.depth},cold=await search(c.query,c.mode,3,undefined,options),rank=cold.page.items.findIndex((i:any)=>i.ref.id===`qmd://notes/${c.expected}.md`)+1;
    assert(rank>0 && rank<=3,`Relevant ${c.expected} missing from top three for ${c.mode}`);
    const warm=await search(c.query,c.mode,3,undefined,options);assert.deepEqual(warm.page.items.map((i:any)=>[i.ref,i.rank]),cold.page.items.map((i:any)=>[i.ref,i.rank]));
    if(c.mode==='hybrid'){
      const item=cold.page.items[rank-1];assert(item.focus,'Hybrid search omitted the selected passage');
      const read=await client!.callTool({name:'read_record',arguments:{ref:item.ref,focus:item.focus}});
      assert(!read.isError,JSON.stringify(read));const result=JSON.parse((read.content as any[])[0].text);
      assert.equal(result.record.ref.version,item.ref.version);assert(result.record.body.includes(c.expected==='event'?'December':'password'));
    }
    assert(cold.ms<(lexicalOnly?15000:90000),`${c.mode} cold search took ${cold.ms} ms, exceeding the release budget`);assert(warm.ms<3000,`${c.mode} repeated search took ${warm.ms} ms (cold: ${cold.ms} ms), exceeding the cache budget`);
    let pageMs:number|undefined;
    if(cold.page.nextCursor){const next=await search(c.query,c.mode,2,cold.page.nextCursor,options);pageMs=next.ms;assert(next.ms<3000,'Pagination reran expensive retrieval');assert(!next.page.items.some((n:any)=>cold.page.items.some((p:any)=>p.ref.id===n.ref.id)));}
    checks.push({query:c.query,mode:c.mode,coldMs:cold.ms,repeatMs:warm.ms,...(pageMs!==undefined?{pageMs}:{}),expectedRank:rank});
  }
  await client.close();client=await connect();
  const reopened=await search('cobaltimeter','lexical');assert(reopened.ms<3000,'Cache did not survive a gateway restart');
  const revisionBefore=JSON.stringify(reopened.page.items.map((i:any)=>i.ref));
  await runSdk(sourceConfig(scoped,source),{index:'vault',action:'update'});
  const unchanged=await search('cobaltimeter','lexical');assert.equal(JSON.stringify(unchanged.page.items.map((i:any)=>i.ref)),revisionBefore);assert(unchanged.ms<3000);
  await writeFile(join(notes,'exact.md'),'# Equipment code\n\nThe instrument was retired.');await runSdk(sourceConfig(scoped,source),{index:'vault',action:'update'});
  assert.equal((await search('cobaltimeter','lexical')).page.items.length,0,'Stale candidates survived a real source edit');
  console.log(JSON.stringify({ok:true,corpus:'259 invented documents plus an excluded collection',inference:lexicalOnly?'not exercised':'installed local models',transport:'stdio MCP with bundled runtime',checks,restartMs:reopened.ms,noOpRefreshMs:unchanged.ms},null,2));
}finally{await client?.close();disposeSearchWorkers();await rm(root,{recursive:true,force:true});}
