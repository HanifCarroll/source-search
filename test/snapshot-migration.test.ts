import {test,expect} from 'bun:test';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {configSchema,sourceScope} from '../src/platform/config';
import {privateDirectory,privateJSON} from '../src/platform/storage';
import {snapshotStore} from '../src/sources/sync/cache';
import {syncSources} from '../src/maintenance/sources';
import {createRuntime} from '../src/application/runtime';
import {versioned,fail} from '../src/domain/identity';
import type {SourceCache} from '../src/domain/snapshots';
import type {SourceProvider} from '../src/sources/sync/model';

const token={env:'UNUSED_FIXTURE_TOKEN'},account='invented';
const definitions={
  agenda:{adapter:'calendars',connector:{type:'google',account,token}},
  people:{adapter:'address-books',connector:{type:'microsoft',account,token}},
  notes:{adapter:'notes',connector:{type:'notion',account,token,pages:['00000000-0000-4000-8000-000000000001']}},
  files:{adapter:'files',roots:['folder'],connector:{type:'google',account,token}},
  issues:{adapter:'issues',connector:{type:'github',account,token,repositories:['example/lab']}},
  chat:{adapter:'chat',connector:{type:'slack',account,token,workspace:'TFIXTURE',channels:['CFIXTURE']}},
  code:{adapter:'repositories',connector:{type:'github',account,token,repositories:['example/lab']}},
};
const record=(source:string,id:string,title=id)=>versioned({ref:{source,id},title,body:'Invented telescope '+title,type:'fixture',locator:'fixture:'+id,observedAt:'2026-10-01T00:00:00Z'});
async function temporary(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-snapshot-migration-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}

test('every connected category migrates its complete legacy snapshot before an offline sync, without changing refs',()=>temporary(async root=>{
  const c=configSchema.parse({maintenanceEnabled:true,enabledSources:Object.keys(definitions),libraryRoot:root,sources:definitions});
  const runtime=createRuntime(c),refs=[];
  for(const source of c.enabledSources){
    const store=snapshotStore(c,source),legacy:SourceCache={version:1,scope:sourceScope(c,source),records:[record(source,'a'),record(source,'b')],checkpoint:{token:source,entries:['a','b']},checkedAt:'2026-10-01T00:00:00Z',coverage:'Selected fixture records',strategy:'delta',warnings:[]};
    await privateDirectory(dirname(store.legacyPath));await privateJSON(store.legacyPath,legacy);
    expect(await store.read()).toEqual(legacy);
    const page=(await runtime.search_sources({queries:[{source,query:'telescope',limit:1}]})).results[0]!;
    refs.push(page.items[0]!.ref);
  }
  await expect(access(snapshotStore(c,'agenda').path)).rejects.toMatchObject({code:'ENOENT'});
  const result=await syncSources(c,undefined,(_c,source)=>({async sync(previous){expect(previous).toEqual({token:source,entries:['a','b']});fail('OFFLINE','Invented offline provider');},async read(){throw Error('Unused');}}));
  expect(result.sources).toHaveLength(7);expect(result.ok).toBe(false);
  for(const ref of refs){
    const store=snapshotStore(c,ref.source),saved=(await store.read())!;
    expect(saved.records.map(r=>r.ref.id)).toEqual(['a','b']);expect(saved.checkpoint).toEqual({token:ref.source,entries:['a','b']});
    expect(saved.checkedAt).toBe('2026-10-01T00:00:00Z');expect(saved.lastError?.code).toBe('OFFLINE');
    expect((await store.original(ref,{async sync(){throw Error('Unused');},async read(id){return record(ref.source,id);}})).ref).toEqual(ref);
    await expect(access(store.legacyPath)).rejects.toMatchObject({code:'ENOENT'});
    const page=(await runtime.search_sources({queries:[{source:ref.source,query:'telescope'}]})).results[0]!;
    expect(page.status).toBe('partial');expect(page.items).toHaveLength(2);
  }
}));

test('shared snapshots retain independent checkpoints through changes, deletions, failure and selection changes',()=>temporary(async root=>{
  const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['agenda','people'],libraryRoot:root,sources:definitions});
  let rows=[record('agenda','a'),record('agenda','b')],token='one',offline=false;
  const provider:SourceProvider={async sync(){if(offline)fail('OFFLINE','Invented failure');return {records:rows,checkpoint:token,coverage:'Fixture calendar',strategy:'delta',warnings:[]};},async read(id){return rows.find(r=>r.ref.id===id)||fail('RECORD_NOT_FOUND','Removed fixture');}};
  expect((await syncSources(c,'agenda',()=>provider)).ok).toBe(true);
  await syncSources(c,'people',()=>({...provider,async sync(){return {...await provider.sync(),records:[record('people','a')],checkpoint:'independent'};}}));
  const store=snapshotStore(c,'agenda'),before=(await store.read())!,people=(await snapshotStore(c,'people').read())!;
  rows=[record('agenda','a','Changed'),record('agenda','c')];token='two';await syncSources(c,'agenda',()=>provider);
  expect((await store.read())!.records).toEqual(rows);expect((await store.read())!.checkpoint).toBe('two');
  await expect(store.original(before.records[0]!.ref,provider)).rejects.toMatchObject({code:'STALE_RECORD'});
  await expect(store.original(before.records[1]!.ref,provider)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  offline=true;token='uncommitted';expect((await syncSources(c,'agenda',()=>provider)).ok).toBe(false);
  expect((await store.read())!.checkpoint).toBe('two');expect(await snapshotStore(c,'people').read()).toEqual(people);
  const changed=configSchema.parse({...c,sources:{...c.sources,agenda:{...definitions.agenda,connector:{...definitions.agenda.connector,account:'different'}}}});
  await expect(snapshotStore(changed,'agenda').read()).rejects.toMatchObject({code:'STALE_INDEX'});
  await syncSources(changed,'agenda',()=>provider);expect((await store.read())!.checkpoint).toBe('two');
  offline=false;rows=[];token='empty';await syncSources(changed,'agenda',()=>provider);
  expect((await snapshotStore(changed,'agenda').read())!.records).toEqual([]);
  // An obsolete JSON file must never revive records after a committed empty scan.
  await privateJSON(store.legacyPath,{...before,scope:sourceScope(changed,'agenda')});
  expect((await snapshotStore(changed,'agenda').read())!.records).toEqual([]);
  await expect(snapshotStore({...changed,enabledSources:[]},'agenda').read()).rejects.toMatchObject({code:'SOURCE_DISABLED'});
}));
