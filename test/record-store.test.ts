import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,writeFile,rm,access,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {recordStore} from '../src/platform/record-store';
import {privateDirectory,privateJSON} from '../src/platform/storage';
import {configSchema,sourceScope} from '../src/platform/config';
import {snapshotStore} from '../src/sources/sync/cache';
import {taskProvider} from '../src/sources/tasks';
import {syncTasks} from '../src/maintenance/sources';
import {createRuntime} from '../src/application/runtime';
import {versioned} from '../src/domain/identity';
import type {SourceCache} from '../src/domain/snapshots';

async function temporary(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-record-store-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const record=(source:string,id:string,title=id)=>versioned({ref:{source,id},title,body:title,type:'task',locator:'fixture:'+id,observedAt:'2026-10-01T00:00:00Z'});
const saved=(source='tasks',ids=['a','b']):SourceCache=>({version:1,scope:'scope-'+source,records:ids.map(id=>record(source,id)),checkpoint:{next:'one'},checkedAt:'2026-10-01T00:00:00Z',coverage:'Invented tasks',strategy:'fixture',warnings:[]});

test('interrupted first creation can resume, while unrelated databases are left untouched',()=>temporary(async root=>{
 const store=recordStore(join(root,'records.sqlite'));await writeFile(store.path,'',{mode:0o600});
 expect(await store.read('tasks','scope-tasks')).toBeUndefined();await store.write('tasks',saved());expect((await store.read('tasks','scope-tasks'))!.records).toHaveLength(2);
 const other=recordStore(join(root,'other.sqlite')),db=new Database(other.path);db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'keep\')');db.close();await chmod(other.path,0o600);
 await expect(other.write('tasks',saved())).rejects.toMatchObject({code:'UNSUPPORTED_SCHEMA'});
 const check=new Database(other.path,{readonly:true});try{expect(check.query('SELECT * FROM unrelated').all()).toEqual([{value:'keep'}]);expect(check.query('PRAGMA user_version').get()).toEqual({user_version:0});}finally{check.close();}
}));

test('shared store replaces records and checkpoint atomically, including a disk-write failure',()=>temporary(async root=>{
 const store=recordStore(join(root,'records.sqlite')),before=saved();await store.write('tasks',before);
 const db=new Database(store.path);
 // The checkpoint and first record are already updated when the second insert fails.
 db.exec("CREATE TRIGGER fail_fixture BEFORE INSERT ON records WHEN NEW.id='broken' BEGIN SELECT RAISE(ABORT,'injected write failure'); END");db.close();
 await expect(store.write('tasks',{...before,checkpoint:{next:'two'},records:[record('tasks','a','Changed'),record('tasks','broken')]})).rejects.toThrow('injected write failure');
 expect(await store.read('tasks',before.scope)).toEqual(before);
 await store.write('tasks',{...before,checkpoint:{next:'three'},records:[record('tasks','a','Changed')]});
 const after=(await store.read('tasks',before.scope))!;expect(after.records).toHaveLength(1);expect(after.records[0]!.title).toBe('Changed');expect(after.checkpoint).toEqual({next:'three'});
 expect((await stat(store.path)).mode&0o777).toBe(0o600);
}));

test('independent sources share a database without sharing identities, failures or scope',()=>temporary(async root=>{
 const store=recordStore(join(root,'records.sqlite')),one=saved('one'),two=saved('two');
 await Promise.all([store.write('one',one),store.write('two',two)]);
 await store.failure('one',one.scope,{code:'OFFLINE',message:'Invented failure'},'2026-10-02T00:00:00Z');
 expect(await store.read('two',two.scope)).toEqual(two);
 expect((await store.read('one',one.scope))!.checkpoint).toEqual(one.checkpoint);
 await expect(store.read('one','different-account')).rejects.toMatchObject({code:'STALE_INDEX'});
 await store.failure('one','different-account',{code:'WRONG',message:'Wrong scope'},'2026-10-03T00:00:00Z');
 expect((await store.read('one',one.scope))!.lastError!.code).toBe('OFFLINE');
 await store.write('one',{...one,scope:'new-scope',records:[]});
 expect((await store.read('one','new-scope'))!.records).toEqual([]);expect(await store.read('two',two.scope)).toEqual(two);
}));

test('unchanged records are not rewritten on each successful observation',()=>temporary(async root=>{
 const store=recordStore(join(root,'records.sqlite')),before=saved();await store.write('tasks',before);
 const db=new Database(store.path);db.exec("CREATE TRIGGER no_rewrite BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'unchanged row rewritten'); END");db.close();
 await store.write('tasks',{...before,checkedAt:'2026-10-02T00:00:00Z',checkpoint:{next:'two'},records:before.records.map(r=>({...r,observedAt:'2026-10-02T00:00:00Z'}))});
 const after=(await store.read('tasks',before.scope))!;expect(after.records).toEqual(before.records);expect(after.checkedAt).toBe('2026-10-02T00:00:00Z');expect(after.checkpoint).toEqual({next:'two'});
}));

test('legacy task snapshots migrate only during maintenance and survive an offline first sync with saved references',()=>temporary(async root=>{
 const file=join(root,'tasks.json');await writeFile(file,JSON.stringify({version:1,tasks:[{id:'a',title:'Invented telescope'}]}));
 const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['work'],libraryRoot:join(root,'cache'),sources:{work:{adapter:'tasks',connector:{type:'json',paths:[file]}}}});
 const store=snapshotStore(c,'work','task-snapshots'),snapshot=await taskProvider(c,'work').sync();
 const legacy:SourceCache={...snapshot,version:1,scope:sourceScope(c,'work'),checkedAt:'2026-10-01T00:00:00Z',checkpoint:{next:'previous'}};
 await privateDirectory(dirname(store.legacyPath));await privateJSON(store.legacyPath,legacy);
 const runtime=createRuntime(c),before=(await runtime.search_sources({queries:[{source:'work',query:'telescope'}]})).results[0]!;
 expect(before.items).toHaveLength(1);await expect(access(store.path)).rejects.toMatchObject({code:'ENOENT'});
 let checkpoint:unknown;
 const failed=await syncTasks(c,'work',()=>({async sync(previous){checkpoint=previous;throw Error('Invented offline provider');},async read(){throw Error('Unused');}}));
 expect(failed.ok).toBe(false);expect(checkpoint).toEqual(legacy.checkpoint);
 await expect(access(store.legacyPath)).rejects.toMatchObject({code:'ENOENT'});
 expect((await store.read())!.records).toEqual(legacy.records);expect((await store.read())!.checkpoint).toEqual(legacy.checkpoint);
 expect((await runtime.read_record({ref:before.items[0]!.ref})).record.ref).toEqual(before.items[0]!.ref);
 expect((await runtime.search_sources({queries:[{source:'work',query:'telescope'}]})).results[0]!.status).toBe('partial');
 expect((await syncTasks(c,'work')).ok).toBe(true);expect((await store.read())!.lastError).toBeUndefined();
 await expect(snapshotStore({...c,enabledSources:[]},'work','task-snapshots').read()).rejects.toMatchObject({code:'SOURCE_DISABLED'});
}));
