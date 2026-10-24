import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {configSchema} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {syncTasks} from '../src/maintenance/sources';
import {taskDueDate} from '../src/domain/task-fields';
import {snapshotPage} from '../src/domain/snapshot-query';
import {querySchema} from '../src/domain/contracts';
import {taskRecord,checkedTask} from '../src/sources/tasks/model';
import {hash,versioned} from '../src/domain/identity';
import {taskCache} from '../src/sources/tasks';

async function temporary(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-task-query-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const project={id:'observatory',name:'Observatory'};
const tasks=[
 {id:'a',title:'Cobalt telescope',due:'2026-10-26',project},
 {id:'b',title:'Violet telescope',due:'2026-11-01T23:30:00-07:00',project},
 {id:'c',title:'Later telescope',due:'2026-11-02',project},
 {id:'d',title:'Completed telescope',status:'completed',due:'2026-10-26',project},
 {id:'e',title:'Canceled telescope',status:'canceled',due:'2026-10-26',project},
 {id:'f',title:'Undated telescope',project},
 {id:'g',title:'Same name different project',due:'2026-10-26',project:{id:'other',name:'Observatory'}},
];
const window={status:'open',dueFrom:'2026-10-26',dueBefore:'2026-11-02'} as const;
async function fixture(root:string){
 const file=join(root,'tasks.json');await writeFile(file,JSON.stringify({version:1,tasks}));
 const c=configSchema.parse({timeZone:'Asia/Tokyo',maintenanceEnabled:true,enabledSources:['work'],libraryRoot:join(root,'cache'),sources:{work:{adapter:'tasks',connector:{type:'json',paths:[file]}}}});
 await syncTasks(c);return {file,c,runtime:createRuntime(c)};
}

test('exact task filters count the whole selected snapshot, with calendar dates, project IDs and text matching',()=>temporary(async root=>{
 const {c,runtime}=await fixture(root),search=async(extra:object)=>(await runtime.search_sources({queries:[{source:'all-tasks',query:'',task:window,...extra}]})).results[0]!;
 const page=await search({limit:1});expect(page.totalMatches).toBe(3);expect(page.progress?.totalMatches).toBe(3);expect(page.query?.task).toEqual(window);expect(page.query?.sort).toBe('due');
 expect(page.coverage).toMatchObject({kind:'synchronized-snapshot',description:expect.stringContaining('selected JSON files')});expect(page.coverage?.asOf).toBe((await taskCache(c,'work'))!.checkedAt);
 expect((await search({task:{...window,projectId:'observatory'}})).items.map(r=>r.ref.id)).toEqual(['a','b']);
 expect((await search({task:{...window,projectName:'Observatory'}})).totalMatches).toBe(3);
 expect((await search({task:{...window,projectName:'observatory'}})).totalMatches).toBe(0);
 expect((await search({query:'tele',task:{...window,projectId:'observatory'}})).totalMatches).toBe(2);
 expect((await search({query:'telescope',match:'phrase',task:{status:'completed'}})).items.map(r=>r.ref.id)).toEqual(['d']);
 expect((await search({task:{status:'canceled'}})).items.map(r=>r.ref.id)).toEqual(['e']);
 expect((await search({task:{status:'open'}})).items.at(-1)?.ref.id).toBe('f');
 expect((await search({task:{dueFrom:'2027-01-01'}})).totalMatches).toBe(0);
 const otherTimeZone=createRuntime({...c,timeZone:'America/Los_Angeles'});
 expect((await otherTimeZone.search_sources({queries:[{source:'work',query:'',task:window}]})).results[0]!.totalMatches).toBe(3);
 const catalogue=(await runtime.list_sources()).sources[0]!;expect(catalogue.capabilities.filters).toContain('task.dueBefore');expect(catalogue.capabilities.sort).toContain('due');
}));

test('task pagination survives no-op sync and reordered inputs but rejects changed queries and snapshots',()=>temporary(async root=>{
 const {file,c,runtime}=await fixture(root),query={source:'work',query:'',task:window,limit:1};
 const first=(await runtime.search_sources({queries:[query]})).results[0]!,ref=first.items[0]!.ref;
 await writeFile(file,JSON.stringify({version:1,tasks:[...tasks].reverse()}));await syncTasks(c);
 const second=(await runtime.search_sources({queries:[{...query,limit:2,cursor:first.nextCursor}]})).results[0]!;
 expect(second.items.map(r=>r.ref.id)).toEqual(['g','b']);expect(second.nextCursor).toBeUndefined();expect(second.totalMatches).toBe(3);
 const wrong=(await runtime.search_sources({queries:[{...query,task:{status:'completed'},cursor:first.nextCursor}]})).results[0]!;expect(wrong.error?.code).toBe('INVALID_CURSOR');
 expect((await runtime.read_record({ref})).record.ref).toEqual(ref);
 await writeFile(file,JSON.stringify({version:1,tasks:tasks.filter(t=>t.id!=='b').map(t=>t.id==='a'?{...t,status:'completed'}:t)}));await syncTasks(c);
 expect((await runtime.search_sources({queries:[{...query,cursor:first.nextCursor}]})).results[0]!.error?.code).toBe('INVALID_CURSOR');
 await expect(runtime.read_record({ref})).rejects.toMatchObject({code:'STALE_RECORD'});
 const latest=(await runtime.search_sources({queries:[query]})).results[0]!;expect(latest.totalMatches).toBe(1);expect(latest.items[0]!.ref.id).toBe('g');
 await rm(file);expect((await syncTasks(c)).ok).toBe(false);
 const retained=(await runtime.search_sources({queries:[query]})).results[0]!;expect(retained.totalMatches).toBe(1);expect(retained.status).toBe('partial');expect(retained.coverage?.asOf).toBe(latest.coverage?.asOf);expect(retained.coverage?.lastError).toBeDefined();
}));

test('due dates keep the reported calendar day and reject invalid values instead of guessing',()=>{
 for(const raw of ['2026-10-26','2026-10-26T00:30:00+14:00','2026-10-26T23:30:00-1100','2026-10-26T23:30:00Z','2026-10-26T00:00:00 [Pacific Standard Time]'])expect(taskDueDate(raw)).toEqual({dueDate:'2026-10-26'});
 expect(taskDueDate('2028-02-29')).toEqual({dueDate:'2028-02-29'});
 for(const raw of ['2026-02-29','2026-13-01','2026-10-26 garbage','tomorrow','2026-10-26T99:30:00',42])expect(taskDueDate(raw)).toEqual({invalidDueDate:true});
 expect(taskDueDate(undefined)).toEqual({});
 for(const task of [{dueFrom:'2026-02-29'},{dueFrom:'2026-11-02',dueBefore:'2026-10-26'},{status:'done'},{projectId:''}])expect(querySchema.safeParse({source:'work',query:'',task}).success).toBe(false);
});

test('unsupported due dates and old unclassified task records cannot produce misleading complete counts',()=>{
 const good=taskRecord('work','fixture',checkedTask({id:'good',title:'Good',due:'2026-10-26'}),'fixture:good');
 const invalid=taskRecord('work','fixture',checkedTask({id:'invalid',title:'Invalid',due:'next Monday'}),'fixture:invalid');
 const old={...good,type:'historical-task',ref:{...good.ref,id:'old'},metadata:{},task:undefined};
 const coverage={kind:'synchronized-snapshot' as const,asOf:'2026-10-24T00:00:00Z',description:'Invented coverage'};
 const page=snapshotPage([good,invalid,old],querySchema.parse({source:'work',query:'',task:window}),coverage);
 expect(page.items.map(r=>r.ref.id)).toEqual(['good']);expect(page.status).toBe('partial');expect(page.totalMatches).toBeUndefined();expect(page.coverage).toMatchObject({unclassifiedTasks:1,invalidDueDates:1});
 expect(snapshotPage([invalid],querySchema.parse({source:'work',query:'',task:{status:'open'}}),coverage).items).toHaveLength(1);
 // Derived query fields are outside the original identity contract.
 expect(good.ref.version).toBe(versioned({...good,task:undefined}).ref.version);
});

test('Things export filters use deadlines, exclude trash/projects, and retain historical references',()=>temporary(async root=>{
 const archive=join(root,'archive');await mkdir(archive);
 const rows=[
  {uuid:'start',title:'Start only',notes:'',status:'open',trashed:false,dates:{startDate:'2026-10-26'}},
  {uuid:'due',title:'Due task',notes:'',status:'open',trashed:false,dates:{deadline:'2026-10-26'},project:{id:'p',title:'Observatory'}},
  {uuid:'trash',title:'Trashed task',notes:'',status:'open',trashed:true,dates:{deadline:'2026-10-26'}},
 ];
 await writeFile(join(archive,'tasks.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));await writeFile(join(archive,'context.json'),JSON.stringify({TMTask:[{uuid:'p',title:'Observatory',notes:''}]}));await writeFile(join(archive,'snapshot-info.json'),JSON.stringify({taskCount:3,exportedAt:'2025-01-01T00:00:00Z'}));
 const c=configSchema.parse({enabledSources:['archive'],sources:{archive:{adapter:'things-archive',root:archive}}}),runtime=createRuntime(c);
 const page=(await runtime.search_sources({queries:[{source:'all-tasks',query:'',task:window}]})).results[0]!;
 expect(page.totalMatches).toBe(1);expect(page.items[0]!.ref.id).toBe('due');expect(page.items[0]!.task?.project).toEqual({id:'p',name:'Observatory'});expect(page.coverage).toMatchObject({kind:'historical-archive',asOf:'2025-01-01T00:00:00Z'});
 const original=(await runtime.read_record({ref:page.items[0]!.ref})).record;
 expect(original.ref.version).toBe(hash(original.body));
 expect((await runtime.search_sources({queries:[{source:'archive',query:'',task:{}}]})).results[0]!.totalMatches).toBe(2);
 expect((await runtime.search_sources({queries:[{source:'archive',query:'',task:{},conversation:'x'}]})).results[0]!.error?.code).toBe('UNSUPPORTED_FILTER');
 const cached=configSchema.parse({maintenanceEnabled:true,enabledSources:['imported'],libraryRoot:join(root,'cache'),sources:{imported:{adapter:'tasks',connector:{type:'things',root:archive}}}});
 await syncTasks(cached);
 const imported=(await createRuntime(cached).search_sources({queries:[{source:'imported',query:'',task:window}]})).results[0]!;
 expect(imported.coverage).toMatchObject({kind:'historical-archive',asOf:'2025-01-01T00:00:00Z'});expect(imported.coverage?.syncedAt).not.toBe(imported.coverage?.asOf);expect(imported.totalMatches).toBe(1);
}));

test('Things database deadlines support the same query across a separate named source',()=>temporary(async root=>{
 const database=join(root,'things.sqlite'),db=new Database(database),packed=(2026<<16)|(10<<12)|(26<<7);
 db.exec('CREATE TABLE TMTask(uuid TEXT,title TEXT,notes TEXT,type INTEGER,status INTEGER,creationDate REAL,deadline INTEGER,startDate INTEGER,project TEXT,trashed INTEGER)');
 const put=db.query('INSERT INTO TMTask VALUES(?,?,?,?,?,?,?,?,?,?)');put.run('project','Observatory','',1,0,0,null,null,null,0);put.run('a','Due task','',0,0,0,packed,null,'project',0);put.run('b','Start only','',0,0,0,null,packed,'project',0);db.close();
 const c=configSchema.parse({enabledSources:['other'],sources:{other:{adapter:'things-archive',database}}});
 const page=(await createRuntime(c).search_sources({queries:[{source:'other',query:'',task:{...window,projectId:'project'}}]})).results[0]!;
 expect(page.items.map(r=>r.ref.id)).toEqual(['a']);expect(page.items[0]!.task?.dueDate).toBe('2026-10-26');
}));

test('MCP advertises and executes task queries for an independent source, rejecting unsupported filters',()=>temporary(async root=>{
 const {c}=await fixture(root),notes=join(root,'notes');await mkdir(notes);await writeFile(join(notes,'note.md'),'Invented note');
 const config={...c,enabledSources:['work','notes'],sources:{...c.sources,notes:{adapter:'markdown',root:notes}}},path=join(root,'config.json');await writeFile(path,JSON.stringify(config));
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const client=new Client({name:'task-query-fixture',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:path},stderr:'pipe'}));
  const schema=(await client.listTools()).tools.find(t=>t.name==='search_sources')!.inputSchema as any;
  expect(schema.properties.queries.items.properties.task.properties.status.enum).toEqual(['open','completed','canceled']);
  const call=async(query:object)=>JSON.parse(((await client.callTool({name:'search_sources',arguments:{queries:[query]}})).content as any[])[0].text);
  const response=await call({source:'all-tasks',query:'',task:window});expect(response.results[0].totalMatches).toBe(3);
  const hit=response.results[0].items[0],opened=await client.callTool({name:'read_record',arguments:{ref:hit.ref}});expect(JSON.parse((opened.content as any[])[0].text).record.ref).toEqual(hit.ref);
  for(const query of [{source:'notes',query:'',task:{}},{source:'notes',query:'',sort:'due'},{source:'work',query:'',task:{},mode:'hybrid'}])expect((await call(query)).results[0].error.code).toBe('UNSUPPORTED_FILTER');
 }finally{await client.close();}
}));
