import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appleRemindersProvider} from '../src/sources/tasks/apple-reminders';
import {microsoftTodoProvider,graphOrigin,graphLink} from '../src/sources/tasks/microsoft-todo';
import {taskHttp} from '../src/sources/tasks/http';
import {configSchema,sourceScope} from '../src/platform/config';
import {taskProvider,taskCache} from '../src/sources/tasks';
import {syncTasks} from '../src/maintenance/sources';
import {createRuntime} from '../src/application/runtime';
import {microsoftToken,type MicrosoftOAuth} from '../src/platform/microsoft-auth';

const reminder=()=>({type:'reminder',id:'reminder-a',title:'Invented cobalt telescope',notes:'Compare aperture sizes',completed:false,priority:5,list:{id:'home',name:'Home'},due:'2026-11-02',createdAt:'2026-10-20T09:00:00Z',recurrence:['Every week']});
const footer=(count:number)=>({type:'scan_finished',source:'reminders',complete:true,scanned:count});
const task=(id='task-a')=>({id,title:'Invented cobalt telescope',status:'notStarted',body:{contentType:'html',content:'<p>Compare <b>apertures</b></p>'},importance:'high',categories:['optics'],createdDateTime:'2026-10-20T09:00:00Z',dueDateTime:{dateTime:'2026-11-02T00:00:00',timeZone:'Pacific Standard Time'},recurrence:{pattern:{type:'weekly',interval:1,daysOfWeek:['monday']},range:{type:'noEnd',startDate:'2026-11-02'}},checklistItems:[{id:'step',displayName:'Measure the aperture',isChecked:false}],linkedResources:[{id:'link',displayName:'Blueprint',applicationName:'Observatory',webUrl:'https://example.test/plan'}]});
const collection='/me/todo/lists/home/tasks',delta=collection+'/delta';
const page=(value:unknown[],token='one')=>({value,'@odata.deltaLink':graphOrigin+delta+'?$deltatoken='+token});
const lists=()=>({value:[{id:'home',displayName:'Home'},{id:'work',displayName:'Work'}]});
async function temporary(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'ss-task-connectors-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('Apple Reminders maps open/completed tasks and date-only due dates; rejects partial or out-of-scope scans',async()=>{
 let rows:any[]=[reminder(),footer(1)];const calls:string[][]=[];
 const provider=appleRemindersProvider('apple',['home'],async args=>{calls.push(args);return rows;});
 const first=await provider.sync();expect(first.records[0]!.body).toContain('Due: 2026-11-02');expect(first.records[0]!.body).toContain('Compare aperture');expect(calls[0]).toContain('["home"]');
 expect(first.records[0]!.task).toMatchObject({status:'open',dueDate:'2026-11-02',project:{id:'home',name:'Home'}});
 expect((await provider.read(first.records[0]!.ref.id)).ref.version).toBe(first.records[0]!.ref.version);
 rows=[{...reminder(),completed:true,completedAt:'2026-10-21T10:00:00Z'},footer(1)];expect((await provider.sync()).records[0]!.body).toContain('Status: completed');
 for(const bad of [[reminder()],[reminder(),footer(2)],[reminder(),{...footer(1),complete:false}],[{...reminder(),list:{id:'work',name:'Unselected'}},footer(1)]]){
  rows=bad;await expect(provider.sync()).rejects.toThrow();
 }
 rows=[footer(0)];await expect(provider.read('reminder-a')).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
});

test('Apple list discovery and the real task factory preserve search and saved-reference checks using an invented helper',()=>temporary(async dir=>{
 const script=join(dir,'helper.ts'),fixture=join(dir,'data.json');await writeFile(fixture,JSON.stringify([reminder(),footer(1)]));
 await writeFile(script,`const command=process.argv[2];if(command==='reminder-lists'){console.log(JSON.stringify({type:'reminder_list',id:'home',name:'Home'}));console.log(JSON.stringify({type:'scan_finished',source:'reminder-lists',complete:true,scanned:1}));}else if(command==='reminders'){for(const row of await Bun.file(${JSON.stringify(fixture)}).json())console.log(JSON.stringify(row));}else{process.exit(1);}`);
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['apple'],libraryRoot:join(dir,'cache'),sources:{apple:{adapter:'tasks',connector:{type:'apple-reminders',helper:script,launcher:process.execPath,lists:['home']}}}});
 if(process.platform!=='darwin'){await expect(taskProvider(c,'apple').sync()).rejects.toMatchObject({code:'UNSUPPORTED_PLATFORM'});return;}
 expect(await taskProvider(c,'apple').lists!()).toEqual([{id:'home',name:'Home'}]);
 expect((await syncTasks(c)).ok).toBe(true);const runtime=createRuntime(c),page=(await runtime.search_sources({queries:[{source:'all-tasks',query:'aperture'}]})).results[0]!;
 expect(page.items).toHaveLength(1);const ref=page.items[0]!.ref;expect((await runtime.read_record({ref})).record.body).toContain('cobalt');
 await writeFile(fixture,JSON.stringify([{...reminder(),title:'Changed task'},footer(1)]));await expect(runtime.read_record({ref})).rejects.toMatchObject({code:'STALE_RECORD'});
 const previous=(await taskCache(c,'apple'))!.records;
 await writeFile(fixture,JSON.stringify([{type:'error',source:'reminders',code:'authorization-denied',authorization:'denied'}]));
 expect((await syncTasks(c)).ok).toBe(false);expect((await taskCache(c,'apple'))!.records).toEqual(previous);
}));

test('Microsoft follows empty pages, maps steps, merges partial deltas, completes and deletes tasks without writes',async()=>{
 let phase=0;const calls:string[]=[];
 const provider=microsoftTodoProvider('microsoft',['home'],async(path,body)=>{
  expect(body).toBeUndefined();calls.push(path);
  if(path==='/me/todo/lists')return lists();
  if(path.includes('$skiptoken='))return page([task()]);
  if(phase===0)return {value:[],'@odata.nextLink':graphOrigin+delta+'?$skiptoken=next'};
  if(path.endsWith('/checklistItems'))return {value:[{id:'step',displayName:'Measure the aperture',isChecked:true}]};
  if(path.endsWith('/linkedResources'))return {value:[]};
  if(phase===1){expect(path).toContain('$deltatoken=one');return page([{id:'task-a',status:'completed',completedDateTime:{dateTime:'2026-10-23T12:00:00',timeZone:'UTC'}}],'two');}
  return page([{id:'task-a','@removed':{reason:'deleted'}}],'three');
 });
 const first=await provider.sync(),saved=JSON.stringify(first.checkpoint),record=first.records[0]!;
 expect(record.task).toMatchObject({status:'open',dueDate:'2026-11-02',project:{id:'home',name:'Home'}});
 expect(record.body).toContain('Compare apertures');expect(record.body).toContain('[ ] Measure the aperture');expect(record.body).toContain('Pacific Standard Time');expect(record.body).toContain('https://example.test/plan');
 expect(calls.some(p=>p.includes('/work/'))).toBe(false);
 phase=1;const second=await provider.sync(first.checkpoint);expect(second.records[0]!.ref.id).toBe(record.ref.id);expect(second.records[0]!.body).toContain('Status: completed');expect(second.records[0]!.body).toContain('[x] Measure');expect(JSON.stringify(first.checkpoint)).toBe(saved);
 phase=2;expect((await provider.sync(second.checkpoint)).records).toEqual([]);
});

test('Microsoft reconciles list renames/removals, discovers another account and refreshes originals',async()=>{
 let name='Home',present=true,changed=false;
 const provider=microsoftTodoProvider('microsoft',undefined,async path=>{
  if(path==='/me/todo/lists')return {value:present?[{id:'home',displayName:name}]:[]};
  if(path===collection+'/task-a')return {...task(),title:changed?'Revised telescope':task().title};
  return page([task()]);
 });
 const first=await provider.sync();name='Renamed list';const second=await provider.sync(first.checkpoint);expect(second.records[0]!.body).toContain('Renamed list');
 changed=true;const fresh=await provider.read(first.records[0]!.ref.id,second.checkpoint);expect(fresh.title).toBe('Revised telescope');expect(fresh.ref.version).not.toBe(second.records[0]!.ref.version);
 present=false;expect((await provider.sync(second.checkpoint)).records).toEqual([]);await expect(provider.read(first.records[0]!.ref.id,first.checkpoint)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
 const alternate=microsoftTodoProvider('other',['work'],async path=>path==='/me/todo/lists'?{value:[{id:'work',displayName:'Different account'}]}:{value:[task('other-task')],'@odata.deltaLink':graphOrigin+'/me/todo/lists/work/tasks/delta?$deltatoken=other'});
 expect((await alternate.sync()).records[0]!.body).toContain('Different account');
});

test('Microsoft bounds continuation to the exact collection and rejects incomplete or looping scans',async()=>{
 for(const link of ['https://example.test/v1.0'+delta,'https://graph.microsoft.com/v1.0/me/todo/lists/work/tasks/delta','https://graph.microsoft.com@evil.test/v1.0'+delta,graphOrigin+delta+'#fragment'])expect(()=>graphLink(link,delta)).toThrow();
 for(const response of [{value:[]},{value:[],'@odata.nextLink':graphOrigin+delta+'?$expand=checklistItems,linkedResources'},{value:[],'@odata.nextLink':graphOrigin+delta+'?next=1','@odata.deltaLink':graphOrigin+delta+'?delta=1'}]){
  const provider=microsoftTodoProvider('microsoft',['home'],async path=>path==='/me/todo/lists'?lists():response);await expect(provider.sync()).rejects.toThrow();
 }
 await expect(microsoftTodoProvider('microsoft',['missing'],async()=>lists()).sync()).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
});

test('Microsoft expired tokens restart a complete delta; read-only delta rejection falls back without broadening permission',async()=>{
 let expired=false,fallback=false;const paths:string[]=[];
 const provider=microsoftTodoProvider('microsoft',['home'],async path=>{
  paths.push(path);if(path==='/me/todo/lists')return lists();
  if(fallback&&path.includes('/delta'))throw Object.assign(Error('Fixture refusal'),{httpStatus:403});
  if(expired&&path.includes('$deltatoken='))throw Object.assign(Error('Fixture expiry'),{code:'SYNC_STATE_EXPIRED'});
  return fallback?{value:[task('replacement')]}:page([task(expired?'new':'task-a')]);
 });
 const first=await provider.sync();expired=true;expect((await provider.sync(first.checkpoint)).records[0]!.ref.id).not.toBe(first.records[0]!.ref.id);
 fallback=true;const snapshot=await provider.sync(first.checkpoint);expect(snapshot.strategy).toBe('graph-snapshot-row-diff');expect(snapshot.warnings).toHaveLength(1);expect(paths).toContain(collection);
});

test('Microsoft expanded steps follow pagination; absent relationships are fetched and malformed tasks fail',async()=>{
 const root=collection+'/task-a';let bad=false;
 const provider=microsoftTodoProvider('microsoft',['home'],async path=>{
  if(path==='/me/todo/lists')return lists();
  if(path.startsWith(root+'/checklistItems'))return {value:[{id:'next',displayName:'Second step',isChecked:true}]};
  if(path===root+'/linkedResources')return {value:[]};
  const row:any={...task(),status:bad?'unexpected':'waitingOnOthers','checklistItems@odata.nextLink':graphOrigin+root+'/checklistItems?$skiptoken=next'};delete row.linkedResources;
  return page([row]);
 });
 const current=await provider.sync();expect(current.records[0]!.body).toContain('[x] Second step');expect(current.records[0]!.body).toContain('waitingOnOthers');bad=true;await expect(provider.sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
});

test('Microsoft periodically reconciles relationship-only changes missing from the delta feed',async()=>{
 let edited=false;
 const provider=microsoftTodoProvider('microsoft',['home'],async path=>{
  if(path==='/me/todo/lists')return lists();
  if(path.includes('$deltatoken='))return page([]);
  return page([{...task(),checklistItems:[{id:'step',displayName:'Measure the aperture',isChecked:edited}]}]);
 });
 const first=await provider.sync();edited=true;
 const incremental=await provider.sync(first.checkpoint);expect(incremental.records[0]!.body).toContain('[ ] Measure');
 const expired=structuredClone(incremental.checkpoint) as any;expired.lists[0].reconciledAt='2000-01-01T00:00:00Z';
 expect((await provider.sync(expired)).records[0]!.body).toContain('[x] Measure');
});

test('Microsoft HTTP errors reset only recognized state failures and never expose provider error bodies',async()=>{
 let status=410,code='syncStateNotFound';const server=Bun.serve({port:0,fetch(req){expect(req.method).toBe('GET');expect(req.headers.get('Authorization')).toBe('Bearer invented-token');return Response.json({error:{code,message:'private fixture details'}},{status});}});
 try{const http=taskHttp(server.url.toString().replace(/\/$/,''),async()=>'invented-token');
  for(const s of [410,400,404]){status=s;await expect(http('/test')).rejects.toMatchObject({code:'SYNC_STATE_EXPIRED'});}
  status=429;code='TooManyRequests';await expect(http('/test')).rejects.toMatchObject({code:'RATE_LIMITED'});
  status=403;await expect(http('/test')).rejects.toThrow('Provider returned HTTP 403');
 }finally{server.stop(true);}
});

test('Microsoft OAuth caches MSAL state privately, silently refreshes, and rejects account switches',()=>temporary(async dir=>{
 const options:MicrosoftOAuth={clientId:'11111111-1111-4111-8111-111111111111',tenant:'common',cache:join(dir,'credentials','microsoft.json')};let home='fixture-account',silent=0,interactive=0,serialized='';
 const account=()=>({homeAccountId:home}),cache={serialize:()=>JSON.stringify({fixture:true}),deserialize:(data:string)=>{serialized=data;},getAccountByHomeId:async(id:string)=>({homeAccountId:id})};
 const create:any=()=>({getTokenCache:()=>cache,acquireTokenSilent:async(args:any)=>{silent++;expect(args.scopes).toEqual(['https://graph.microsoft.com/Tasks.Read']);return {account:args.account,accessToken:'invented-access'};},acquireTokenByDeviceCode:async(args:any)=>{interactive++;args.deviceCodeCallback({message:'Invented sign-in instructions'});return {account:account(),accessToken:'invented-access'};}});
 await expect(microsoftToken(options,undefined,create)).rejects.toMatchObject({code:'AUTH_REQUIRED'});expect(interactive).toBe(0);
 const prompts:string[]=[];expect(await microsoftToken(options,m=>prompts.push(m),create)).toBe('invented-access');expect(prompts).toHaveLength(1);expect((await stat(options.cache)).mode&0o777).toBe(0o600);
 expect(await microsoftToken(options,undefined,create)).toBe('invented-access');expect(silent).toBe(1);expect(serialized).toContain('fixture');
 const saved=await readFile(options.cache,'utf8');home='different-account';await expect(microsoftToken(options,()=>{},create)).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});expect(await readFile(options.cache,'utf8')).toBe(saved);
}));

test('Microsoft scopes preserve token rotation but isolate list and account changes; failed sync preserves the checkpoint',()=>temporary(async dir=>{
 const connector={type:'microsoft-todo',account:'fixture-one',lists:['home'],token:{env:'UNUSED_FIXTURE'}};
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['microsoft'],libraryRoot:join(dir,'cache'),sources:{microsoft:{adapter:'tasks',connector}}});
 const withConnector=(updates:object)=>configSchema.parse({...c,sources:{microsoft:{adapter:'tasks',connector:{...connector,...updates}}}});
 expect(sourceScope(c,'microsoft')).toBe(sourceScope(withConnector({token:{env:'ROTATED_FIXTURE'}}),'microsoft'));
 for(const update of [{account:'fixture-two'},{lists:['work']}])expect(sourceScope(c,'microsoft')).not.toBe(sourceScope(withConnector(update),'microsoft'));
 let broken=false;const factory=()=>microsoftTodoProvider('microsoft',['home'],async path=>{if(path==='/me/todo/lists')return lists();if(broken)throw Object.assign(Error('Fixture offline'),{code:'TIMEOUT'});return page([task()]);});
 expect((await syncTasks(c,undefined,factory)).ok).toBe(true);const prior=await taskCache(c,'microsoft');broken=true;expect((await syncTasks(c,undefined,factory)).ok).toBe(false);
 expect((await taskCache(c,'microsoft'))!.checkpoint).toEqual(prior!.checkpoint);expect((await taskCache(c,'microsoft'))!.records).toEqual(prior!.records);
 expect(JSON.stringify(await taskCache(c,'microsoft'))).not.toContain('UNUSED_FIXTURE');
}));
