import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordStore} from '../src/platform/record-store';
import {configSchema} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {syncSources} from '../src/maintenance/sources';
import {versioned} from '../src/domain/identity';
import type {SourceCache} from '../src/domain/snapshots';

async function temp(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-changes-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const record=(id:string,title=id)=>versioned({ref:{source:'tasks',id},title,body:title,type:'task',locator:'fixture',observedAt:'2026-10-01T00:00:00Z'});
const saved=(ids=['a','b']):SourceCache=>({version:1,scope:'scope',records:ids.map(id=>record(id)),checkedAt:'2026-10-01T00:00:00Z',checkpoint:'first',strategy:'fixture',coverage:'Selected fixture list',warnings:[]});

test('source change feed begins with a baseline and records additions, updates and removals exactly once',()=>temp(async root=>{
  const store=recordStore(join(root,'records.sqlite')),selection={tasks:'scope'},start=await store.changes(selection,undefined,10);
  await store.write('tasks',saved());const first=await store.changes(selection,start.cursor,10);
  expect(start.streamId).toBeNull();expect(first.streamId).toEqual(expect.any(String));
  expect(first.items.map(r=>r.kind)).toEqual(['reset']);
  const next={...saved(),checkedAt:'2026-10-02T00:00:00Z',records:[record('a','Changed'),record('c')]};
  await store.write('tasks',next);
  const page=await store.changes(selection,first.cursor,1);expect(page.hasMore).toBe(true);
  const rest=await store.changes(selection,page.cursor,10);
  expect(rest.streamId).toBe(first.streamId);
  expect([...page.items,...rest.items].map(r=>[r.kind,r.ref?.id])).toEqual([['updated','a'],['added','c'],['removed','b']]);
  await store.write('tasks',{...next,records:next.records.toReversed().map(r=>({...r,observedAt:'2026-10-03T00:00:00Z'}))});
  expect((await store.changes(selection,rest.cursor,10)).items).toEqual([]);
  await store.failure('tasks','scope',{code:'OFFLINE',message:'Fixture offline'},'2026-10-04T00:00:00Z');
  const failure=await store.changes(selection,rest.cursor,10);expect(failure.items).toEqual([]);expect((failure.coverage[0] as any).coverage.lastError.code).toBe('OFFLINE');
}));

test('feed events and snapshots roll back together and scope changes cannot leak old records',()=>temp(async root=>{
  const store=recordStore(join(root,'records.sqlite'));await store.write('tasks',saved());const baseline=await store.changes({tasks:'scope'},undefined,10);
  const db=new Database(store.path);db.exec("CREATE TRIGGER fail_row BEFORE INSERT ON records WHEN NEW.id='broken' BEGIN SELECT RAISE(ABORT,'write failure'); END");db.close();
  await expect(store.write('tasks',{...saved(),records:[record('a','changed'),record('broken')]})).rejects.toThrow('write failure');
  expect((await store.changes({tasks:'scope'},baseline.cursor,10)).items).toEqual([]);
  await store.write('tasks',{...saved(['new']),scope:'new-scope'});
  const newSelection=await store.changes({tasks:'new-scope'},undefined,10);expect(newSelection.items).toHaveLength(1);expect(newSelection.items[0]!.kind).toBe('reset');
  expect(JSON.stringify(newSelection)).not.toContain('"id":"a"');
  await expect(store.changes({tasks:'new-scope'},baseline.cursor,10)).rejects.toMatchObject({code:'INVALID_CURSOR'});
  await rm(store.path);await expect(store.changes({tasks:'new-scope'},newSelection.cursor,10)).rejects.toMatchObject({code:'FEED_RESET'});
  await store.write('tasks',{...saved(),scope:'new-scope'});await expect(store.changes({tasks:'new-scope'},newSelection.cursor,10)).rejects.toMatchObject({code:'FEED_RESET'});
}));

test('legacy record database upgrades only on a write and preserves its records and references',()=>temp(async root=>{
  const store=recordStore(join(root,'records.sqlite')),snapshot=saved(),{records,...state}=snapshot;
  const db=new Database(store.path);db.exec(`CREATE TABLE snapshots(source TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE records(source TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,signature TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,id),FOREIGN KEY(source) REFERENCES snapshots(source) ON DELETE CASCADE);
    CREATE INDEX records_order ON records(source,ordinal);PRAGMA user_version=1;`);
  db.query('INSERT INTO snapshots VALUES(?,?,?)').run('tasks','scope',JSON.stringify(state));
  records.forEach((r,i)=>db.query('INSERT INTO records VALUES(?,?,?,?,?)').run('tasks',r.ref.id,i,'legacy',JSON.stringify(r)));db.close();await chmod(store.path,0o600);
  expect(await store.read('tasks','scope')).toEqual(snapshot);
  expect((await store.changes({tasks:'scope'},undefined,10)).coverage[0]!.state).toBe('needs-sync');
  const check=new Database(store.path,{readonly:true});expect(check.query('PRAGMA user_version').get()).toEqual({user_version:1});check.close();
  await store.write('tasks',snapshot);
  expect(await store.read('tasks','scope')).toEqual(snapshot);
  const events=await store.changes({tasks:'scope'},undefined,10);expect(events.items[0]!.kind).toBe('reset');
}));

test('runtime reports direct-reader coverage honestly, enforces source access and sees real file synchronization',()=>temp(async root=>{
  const file=join(root,'tasks.json');await writeFile(file,JSON.stringify({version:1,tasks:[{id:'a',title:'Invented first task'}]}));
  const c=configSchema.parse({memoryRoot:join(root,'memory'),libraryRoot:join(root,'cache'),maintenanceEnabled:true,enabledSources:['tasks','notes'],sources:{tasks:{adapter:'tasks',connector:{type:'json',paths:[file]}},notes:{adapter:'markdown',root}}});
  const rt=createRuntime(c);expect((await syncSources(c,'tasks')).ok).toBe(true);
  const page=await rt.list_changes({feed:'sources',sources:['tasks','notes']}) as any;
  expect(page.coverage.find((s:any)=>s.source==='notes').state).toBe('unsupported');
  await writeFile(file,JSON.stringify({version:1,tasks:[{id:'a',title:'Invented revised task'},{id:'b',title:'Invented second task'}]}));
  expect((await syncSources(c,'tasks')).ok).toBe(true);
  const changes=await rt.list_changes({feed:'sources',sources:['notes','tasks'],cursor:page.cursor}) as any;
  expect(changes.items.map((c:any)=>c.kind)).toEqual(['updated','added']);
  for(const item of changes.items)expect((await rt.read_record({ref:item.ref})).record.ref).toEqual(item.ref);
  await expect(createRuntime({...c,enabledSources:[]}).list_changes({feed:'sources',sources:['tasks']})).rejects.toMatchObject({code:'SOURCE_DISABLED'});
}));

test('direct observations commit inventory and events together, retain failures and reset changing windows',()=>temp(async root=>{
  const store=recordStore(join(root,'records.sqlite')),selection={notes:'scope'};
  const entry=(id:string,signature=id)=>({ref:{source:'notes',id,version:signature},signature,input:'stat-'+signature});
  const state={checkedAt:'2026-10-24T00:00:00Z',strategy:'file-diff',coverage:'Selected files'};
  await store.observe('notes','scope',[entry('a'),entry('b')],state);
  const first=await store.changes(selection,undefined,10);expect(first.items.map(e=>e.kind)).toEqual(['reset']);
  await store.observe('notes','scope',[entry('a','edited'),entry('c')],state);
  const next=await store.changes(selection,first.cursor,10);
  expect(next.items.map(e=>[e.kind,e.ref?.id])).toEqual([['updated','a'],['added','c'],['removed','b']]);
  await store.observationFailure('notes','scope',{code:'OFFLINE',message:'Incomplete inventory'},state.checkedAt);
  expect((await store.changes(selection,next.cursor,10)).items).toEqual([]);
  expect((await store.observation('notes','scope'))?.entries).toHaveLength(2);
  const db=new Database(store.path);db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON observations WHEN NEW.id='broken' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");db.close();
  await expect(store.observe('notes','scope',[entry('a','edited again'),entry('broken')],state)).rejects.toThrow('fixture failure');
  expect((await store.changes(selection,next.cursor,10)).items).toEqual([]);
  expect((await store.observation('notes','scope'))?.entries.find(e=>e.ref.id==='a')?.signature).toBe('edited');
  await store.observe('notes','scope',undefined,state);
  expect((await store.changes(selection,next.cursor,10)).items).toEqual([]);
  await store.observe('notes','scope',[entry('d')],{...state,generation:'new-window'});
  expect((await store.changes(selection,next.cursor,10)).items.map(e=>e.kind)).toEqual(['reset']);
  await expect(store.observe('notes','different',undefined,state)).rejects.toMatchObject({code:'INCOMPLETE_SCAN'});
  expect((await store.changes({notes:'different'},undefined,10)).coverage[0]!.state).toBe('needs-sync');
  const check=new Database(store.path,{readonly:true});expect(check.query('PRAGMA user_version').get()).toEqual({user_version:3});check.close();
}));
