import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configSchema,sourceScope} from '../src/platform/config';
import {todoistProvider} from '../src/sources/tasks/todoist';
import {ticktickProvider} from '../src/sources/tasks/ticktick';
import {taskHttp} from '../src/sources/tasks/http';
import {taskCache,taskCachePath} from '../src/sources/tasks';
import {syncTasks} from '../src/maintenance/tasks';
import {createRuntime} from '../src/application/runtime';
import {libraryDB,getState} from '../src/search/library/store';
import {indexSources} from '../src/maintenance/search-index';

const item=(id='one')=>({id,project_id:'project',section_id:'section',parent_id:null,content:'Invented observatory task '+id,description:'Compare telescope lenses',checked:false,labels:['optics'],priority:4,added_at:'2026-01-01T12:00:00Z',due:{date:'2026-11-01',is_recurring:true,string:'every month'},deadline:{date:'2026-12-01'}});
const full=()=>({sync_token:'initial',full_sync:true,items:[item()],projects:[{id:'project',name:'Observatory'}],sections:[{id:'section',name:'Procurement'}],notes:[{id:'comment',item_id:'one',content:'Check the aperture'}]});
const delta=(token:string,extra:Record<string,unknown>={})=>({sync_token:token,full_sync:false,...extra});
async function temporary(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-tasks-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}

test('Todoist full snapshot, follow-up delta, edits, completion and deletion use read-only sync',async()=>{
 const responses=[full(),delta('current',{items:[{...item(),description:'Updated telescope notes'}]}),delta('renamed',{projects:[{id:'project',name:'Renamed project'}],notes:[{id:'comment',item_id:'one',content:'Revised aperture'}]}),delta('completed',{items:[{id:'one',checked:true}]}),delta('reopened',{items:[item()]}),delta('removed',{projects:[{id:'project',is_deleted:true}]})];
 const calls:any[]=[];
 const p=todoistProvider('work',async(path,body)=>{calls.push({path,body});return responses.shift();});
 const first=await p.sync();expect(calls.map(c=>c.body.sync_token)).toEqual(['*','initial']);
 expect(first.records).toHaveLength(1);expect(first.records[0]!.body).toContain('Updated telescope notes');
 for(const text of ['Procurement','Observatory','optics','2026-11-01','2026-12-01','Check the aperture'])expect(first.records[0]!.body).toContain(text);
 const second=await p.sync(first.checkpoint);expect(second.records[0]!.body).toContain('Renamed project');expect(second.records[0]!.ref.version).not.toBe(first.records[0]!.ref.version);
 expect((first.checkpoint as any).token).toBe('current');
 const completed=await p.sync(second.checkpoint);expect(completed.records).toHaveLength(0);
 const reopened=await p.sync(completed.checkpoint);expect(reopened.records).toHaveLength(1);
 expect((await p.sync(reopened.checkpoint)).records).toHaveLength(0);
 expect(calls.every(c=>c.path==='/sync'&&!('commands' in c.body))).toBe(true);
});

test('Todoist validates complete initial snapshots and reads fresh original versions',async()=>{
 await expect(todoistProvider('work',async()=>({...full(),notes:undefined})).sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
 await expect(todoistProvider('work',async()=>delta('invalid')).sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
 const replies=[full(),delta('current'),delta('edited',{items:[{...item(),content:'Changed original task'}]}),delta('deleted',{items:[{id:'one',is_deleted:true}]})];
 const p=todoistProvider('work',async()=>replies.shift()),snapshot=await p.sync();
 expect((await p.read('one',snapshot.checkpoint)).ref.version).not.toBe(snapshot.records[0]!.ref.version);
 await expect(p.read('one',snapshot.checkpoint)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
 await expect(p.read('../other',snapshot.checkpoint)).rejects.toMatchObject({code:'INVALID_REFERENCE'});
});

test('TickTick maps selected project snapshots, subtasks and checklists without writes',async()=>{
 const calls:string[]=[];
 const p=ticktickProvider('personal',['p1','p2'],async(path,body)=>{
  expect(body).toBeUndefined();calls.push(path);const id=path.split('/')[2];
  return {project:{id,name:'Project '+id},columns:[{id:'column',name:'Next'}],tasks:[{id:'task-'+id,projectId:id,title:'Invented task',content:'Description',desc:'Checklist description',status:0,columnId:'column',parentId:'parent',priority:5,dueDate:'2026-11-01T09:00:00+0000',tags:['home'],items:[{title:'First step',status:1},{title:'Second step',status:0}]}]};
 });
 const s=await p.sync();expect(calls).toEqual(['/project/p1/data','/project/p2/data']);expect(s.records).toHaveLength(2);
 for(const text of ['Parent task: parent','[x] First step','[ ] Second step','Next','home','Description'])expect(s.records[0]!.body).toContain(text);
 expect(s.records[0]!.occurredAt).toBeUndefined();expect(s.coverage).toContain('completed-task history');
 await expect(ticktickProvider('bad',['p1'],async()=>({project:{id:'p2',name:'Wrong'},tasks:[]})).sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
 await expect(ticktickProvider('bad',['p1'],async()=>({project:{id:'p1',name:'Partial'}})).sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
});

test('HTTP adapter bounds failures and sends bearer secrets only in the header',async()=>{
 const requests:any[]=[];
 const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request){requests.push({url:request.url,method:request.method,authorization:request.headers.get('authorization'),contentType:request.headers.get('content-type'),body:request.method==='POST'?Object.fromEntries(new URLSearchParams(await request.text())):undefined});return request.url.endsWith('/limited')?new Response('private server details',{status:429}):Response.json({ok:true});}});
 process.env.SOURCE_SEARCH_TEST_TASK_TOKEN='invented-token';
 try{
  const http=taskHttp('http://127.0.0.1:'+server.port,{env:'SOURCE_SEARCH_TEST_TASK_TOKEN'},'form');
  expect(await http('/sync',{sync_token:'*',resource_types:['items']})).toEqual({ok:true});
  expect(requests[0]).toMatchObject({method:'POST',authorization:'Bearer invented-token',contentType:'application/x-www-form-urlencoded',body:{sync_token:'*',resource_types:'["items"]'}});
  expect(requests[0].url).not.toContain('invented-token');
  await expect(http('/limited')).rejects.toMatchObject({code:'RATE_LIMITED',message:'Task provider returned HTTP 429'});
 }finally{server.stop(true);delete process.env.SOURCE_SEARCH_TEST_TASK_TOKEN;}
});

test('different task apps share search, groups, pagination, publication and reference validation',()=>temporary(async root=>{
 const file=join(root,'tasks.json');await writeFile(file,JSON.stringify({version:1,tasks:[{id:'a',title:'Cobalt task',description:'Invented observatory plan',createdAt:'2026-01-01T12:00:00Z'},{id:'b',title:'Violet task',description:'Invented follow-up',status:'completed'}]}));
 const c=configSchema.parse({maintenanceEnabled:true,libraryEnabled:true,enabledSources:['work','library'],libraryRoot:join(root,'cache'),libraryDatabase:join(root,'search.sqlite'),sources:{work:{adapter:'tasks',connector:{type:'json',paths:[file]}}}});
 const runtime=createRuntime(c);
 expect((await runtime.search_sources({queries:[{source:'work',query:'task'}]})).results[0]!.error?.code).toBe('NEEDS_SYNC');
 expect((await syncTasks(c)).ok).toBe(true);
 const catalogue=await runtime.list_sources();expect(catalogue.groups['all-tasks']).toEqual(['work']);expect(catalogue.sources.find(s=>s.source==='work')).toMatchObject({category:'tasks',available:true,records:2});
 const page=(await runtime.search_sources({queries:[{source:'all-tasks',query:'task',limit:1}]})).results[0]!;
 expect(page.items).toHaveLength(1);expect(page.nextCursor).toBeDefined();
 const second=(await runtime.search_sources({queries:[{source:'work',query:'task',limit:1,cursor:page.nextCursor}]})).results[0]!;
 expect(second.items[0]!.ref.id).not.toBe(page.items[0]!.ref.id);
 expect((await runtime.read_record({ref:page.items[0]!.ref})).record.body).toContain('Cobalt');
 const db=libraryDB(c),revision=getState(db,'work').projectionRevision;db.close();
 await syncTasks(c);const after=libraryDB(c);expect(getState(after,'work').projectionRevision).toBe(revision);after.close();
 await indexSources(c,['--library','--update-only']);
 expect((await runtime.search_sources({queries:[{source:'library',query:'cobalt',mode:'lexical'}]})).results[0]!.items).toHaveLength(1);
 await writeFile(file,JSON.stringify({version:1,tasks:[{id:'a',title:'Changed task'}]}));
 await expect(runtime.read_record({ref:page.items[0]!.ref})).rejects.toMatchObject({code:'STALE_RECORD'});
 expect((await syncTasks(c)).ok).toBe(true);
 expect((await taskCache(c,'work'))!.records).toHaveLength(1);
 const disabled=createRuntime({...c,enabledSources:['library']});
 expect((await disabled.search_sources({queries:[{source:'all-tasks',query:'task'}]})).results[0]!.error?.code).toBe('SOURCE_DISABLED');
}));

test('failed provider passes preserve the complete snapshot and checkpoint; account changes never reuse them',()=>temporary(async root=>{
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['work'],libraryRoot:root,sources:{work:{adapter:'tasks',connector:{type:'todoist',account:'invented-one',token:{env:'UNUSED'}}}}});
 const replies=[full(),delta('current')];const provider=todoistProvider('work',async()=>replies.shift());
 expect((await syncTasks(c,undefined,()=>provider)).ok).toBe(true);
 const before=await readFile(taskCachePath(c,'work'),'utf8');
 expect((await syncTasks(c,undefined,()=>todoistProvider('work',async()=>{throw Error('Offline fixture');}))).ok).toBe(false);
 const retained=await taskCache(c,'work'),original=JSON.parse(before);
 expect(retained!.records).toEqual(original.records);expect(retained!.checkpoint).toEqual(original.checkpoint);expect(retained!.checkedAt).toBe(original.checkedAt);
 expect((await createRuntime(c).list_sources()).sources[0]!.state).toBe('error');
 expect((await createRuntime(c).search_sources({queries:[{source:'work',query:'observatory'}]})).results[0]!.status).toBe('partial');
 const moved=configSchema.parse({...c,sources:{work:{adapter:'tasks',connector:{type:'todoist',account:'invented-two',token:{env:'UNUSED'}}}}});
 await expect(taskCache(moved,'work')).rejects.toMatchObject({code:'STALE_INDEX'});
 let checkpoint:unknown='not called';
 await syncTasks(moved,undefined,()=>({sync:async previous=>{checkpoint=previous;return {records:[],strategy:'fixture',coverage:'Empty alternate account',warnings:[]};},read:async()=>{throw Error();}}));
 expect(checkpoint).toBeUndefined();expect((await taskCache(moved,'work'))!.records).toEqual([]);
 const rotated=configSchema.parse({...moved,sources:{work:{adapter:'tasks',connector:{type:'todoist',account:'invented-two',token:{env:'ROTATED'}}}}});
 expect(sourceScope(rotated,'work')).toBe(sourceScope(moved,'work'));
 await expect(syncTasks({...c,maintenanceEnabled:false})).rejects.toMatchObject({code:'MAINTENANCE_DISABLED'});
}));

test('generic browser adapters work across separate Chromium-compatible profiles',()=>temporary(async root=>{
 const sources:Record<string,unknown>={};
 for(const id of ['edge','brave']){const path=join(root,id);await mkdir(path);await writeFile(join(path,'Bookmarks'),JSON.stringify({roots:{bar:{type:'folder',children:[{id:'42',type:'url',name:'Invented '+id,url:'https://example.test/'+id,date_added:'13300000000000000'}]}}}));sources[id]={adapter:'browser-bookmarks',profiles:[{id:'work',path}]};}
 const c=configSchema.parse({enabledSources:['edge','brave'],sources}),runtime=createRuntime(c);
 expect((await runtime.list_sources()).groups['all-bookmarks']).toEqual(['edge','brave']);
 const pages=(await runtime.search_sources({queries:[{source:'all-bookmarks',query:'invented'}]})).results;
 expect(pages.every(p=>p.items.length===1)).toBe(true);
 expect((await runtime.read_record({ref:pages[1]!.items[0]!.ref})).record.body).toContain('example.test/brave');
}));

test('task sync writers serialize and release their lock after failure',()=>temporary(async root=>{
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['work'],libraryRoot:root,sources:{work:{adapter:'tasks',connector:{type:'todoist',account:'fixture',token:{env:'UNUSED'}}}}});
 let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
 const first=syncTasks(c,undefined,()=>({sync:async()=>{entered();await pending;throw Error('Interrupted fixture');},read:async()=>{throw Error();}}));
 await started;
 const blocked=await syncTasks(c,undefined,()=>{throw Error('Second writer must not reach the provider');});
 expect(blocked.sources[0]).toMatchObject({ok:false,error:{code:'ELOCKED'}});
 finish();await first;
 expect((await syncTasks(c,undefined,()=>({sync:async()=>({records:[],coverage:'Empty fixture',warnings:[],strategy:'fixture'}),read:async()=>{throw Error();}}))).ok).toBe(true);
}));

test('task references reject a switched file selection even when task IDs and content match',()=>temporary(async root=>{
 const first=join(root,'first.json'),second=join(root,'second.json'),data=JSON.stringify({version:1,tasks:[{id:'shared',title:'Identical invented task'}]});
 await writeFile(first,data);await writeFile(second,data);
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['work'],libraryRoot:join(root,'cache'),sources:{work:{adapter:'tasks',connector:{type:'json',paths:[first]}}}});
 await syncTasks(c);const r=createRuntime(c),ref=(await r.search_sources({queries:[{source:'work',query:'task'}]})).results[0]!.items[0]!.ref;
 const changed=configSchema.parse({...c,sources:{work:{adapter:'tasks',connector:{type:'json',paths:[second]}}}});
 await syncTasks(changed);
 await expect(createRuntime(changed).read_record({ref})).rejects.toMatchObject({code:'STALE_RECORD'});
}));
