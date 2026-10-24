import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {configSchema} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {memoryStore} from '../src/platform/memory-store';
import {exportMemory,restoreMemory} from '../src/platform/memory-backup';
import {hash,stableJson} from '../src/domain/identity';
import {writeMemorySchema} from '../src/domain/memory';

async function fixture(fn:(root:string,c:ReturnType<typeof configSchema.parse>,rt:ReturnType<typeof createRuntime>)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'ss-memory-'));
  try{
    await mkdir(join(root,'notes'));await writeFile(join(root,'notes','Cobalt.md'),'# Cobalt\nThe test telescope passed its alignment check.');
    const c=configSchema.parse({memoryRoot:join(root,'memory'),enabledSources:['notes'],sources:{notes:{adapter:'markdown',root:join(root,'notes')}},contextEntities:{cobalt:{kind:'project',label:'Cobalt'}}});
    await fn(root,c,createRuntime(c));
  }finally{await rm(root,{recursive:true,force:true});}
}
const request=(text='Prefer brief summaries')=>({operationId:randomUUID(),reason:'Explicit invented instruction',memory:{kind:'preference',text}});

test('durable memories have revisions, checked edits, retractions and retry receipts',()=>fixture(async(root,c,rt)=>{
  expect((await rt.list_memories({})).items).toEqual([]);await expect(stat(c.memoryRoot)).rejects.toMatchObject({code:'ENOENT'});
  const input=request(),a=await rt.write_memory(input);
  expect(a.memory.revision).toBe(1);expect((await rt.write_memory(input)).replayed).toBe(true);
  await expect(rt.write_memory({...input,reason:'different'})).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
  const edit={...request('Use detailed summaries'),id:a.memory.id,expectedRevision:1};
  const b=await rt.write_memory(edit);expect(b.memory.revision).toBe(2);
  await expect(rt.write_memory({...edit,operationId:randomUUID()})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  expect((await rt.read_memory({id:a.memory.id,revision:1})).memory.text).toBe('Prefer brief summaries');
  const retract={operationId:randomUUID(),action:'retract',id:a.memory.id,expectedRevision:2,reason:'Withdrawn by the user'};
  expect((await rt.write_memory(retract)).memory.status).toBe('retracted');
  expect((await rt.list_memories({})).items).toEqual([]);expect((await rt.list_memories({includeRetracted:true})).items).toHaveLength(1);
  expect((await rt.write_memory(input)).memory.revision).toBe(1);
  expect((await stat(join(c.memoryRoot,'memory.sqlite'))).mode&0o777).toBe(0o600);
}));

test('outcome attestations require explicit method and current cited evidence, without promoting statements',()=>fixture(async(root,c,rt)=>{
  const ref=(await rt.search_sources({queries:[{source:'notes',query:'Cobalt'}]})).results[0]!.items[0]!.ref;
  const statement=await rt.write_memory({...request('The telescope is ready'),memory:{kind:'outcome',text:'The telescope is ready',evidence:[{ref}]}});
  expect(statement.memory.knowledge).toBe('statement');
  const memory={kind:'outcome',text:'The alignment check passed',entities:['cobalt'],evidence:[{ref,quote:'passed its alignment check'}],verification:{method:'Read the recorded test result',observation:'Alignment check passed',by:'Fixture evaluator'}};
  const verified=await rt.write_memory({...request(),memory});expect(verified.memory.knowledge).toBe('verified-outcome-attestation');
  expect((await rt.read_memory({id:verified.memory.id,checkEvidence:true})).evidenceChecks![0]!.status).toBe('current');
  await expect(rt.write_memory({...request(),memory:{...memory,evidence:[]}})).rejects.toThrow();
  await expect(rt.write_memory({...request(),memory:{...memory,evidence:[{ref,quote:'invented false quote'}]}})).rejects.toMatchObject({code:'EVIDENCE_MISMATCH'});
  await writeFile(join(root,'notes','Cobalt.md'),'# Cobalt\nThe next check failed.');
  await expect(rt.write_memory({...request(),memory})).rejects.toMatchObject({code:'STALE_RECORD'});
  const read=await rt.read_memory({id:verified.memory.id,checkEvidence:true});expect(read.evidenceChecks![0]!.status).toBe('unavailable');
  expect(read.memory.revision).toBe(1);expect(read.memory.text).toBe('The alignment check passed');
  const disabled=createRuntime({...c,enabledSources:[]});
  const hidden=await disabled.read_memory({id:verified.memory.id,checkEvidence:true});
  expect(JSON.stringify(hidden.memory.evidence)).not.toContain(ref.id);expect(hidden.evidenceChecks![0]!.status).toBe('unavailable');
  const relocated=createRuntime({...c,sources:{notes:{...c.sources.notes!,root:join(root,'other')} as any}});
  expect(JSON.stringify((await relocated.read_memory({id:verified.memory.id})).memory.evidence)).not.toContain(ref.id);
}));

test('corrections cite a specific previous memory without silently rewriting it',()=>fixture(async(_root,_c,rt)=>{
  const first=(await rt.write_memory(request())).memory;
  await expect(rt.write_memory({...request(),memory:{kind:'correction',text:'Use detailed summaries'}})).rejects.toThrow();
  await expect(rt.write_memory({...request(),memory:{kind:'correction',text:'Use detailed summaries',corrects:{id:randomUUID(),revision:1}}})).rejects.toMatchObject({code:'MISSING_MEMORY'});
  const correction=(await rt.write_memory({...request(),memory:{kind:'correction',text:'Use detailed summaries',corrects:{id:first.id,revision:1}}})).memory;
  expect(correction.corrects).toEqual({id:first.id,revision:1});
  const read=await rt.read_memory({id:first.id});expect(read.memory.text).toBe(first.text);
  expect(read.corrections.items[0]!.id).toBe(correction.id);
  expect((await rt.list_memories({kind:'correction',query:'DETAILED'})).items).toHaveLength(1);
  await rt.write_memory({operationId:randomUUID(),action:'retract',id:correction.id,expectedRevision:1,reason:'Correction withdrawn'});
  expect((await rt.read_memory({id:first.id})).corrections.items).toEqual([]);
}));

test('pagination stays stable while memories change and the feed resumes after a restart',()=>fixture(async(_root,c,rt)=>{
  const empty=await rt.list_changes({feed:'memory'}) as any;
  const a=(await rt.write_memory(request('one'))).memory,b=(await rt.write_memory(request('two'))).memory;
  const page=await rt.list_memories({limit:1});expect(page.items[0]!.id).toBe(b.id);
  await rt.write_memory({...request('one revised'),id:a.id,expectedRevision:1});
  expect((await rt.list_memories({limit:1,cursor:page.nextCursor})).items[0]!.text).toBe('one');
  const first=await rt.list_changes({feed:'memory',cursor:empty.cursor,limit:1}) as any;
  expect(empty.streamId).toBeNull();expect(first.streamId).toEqual(expect.any(String));
  expect(first.items[0].id).toBe(a.id);expect(first.hasMore).toBe(true);
  const second=await createRuntime(c).list_changes({feed:'memory',cursor:first.cursor,limit:2}) as any;
  expect(second.streamId).toBe(first.streamId);
  expect(second.items.map((i:any)=>i.sequence)).toEqual([2,3]);expect(second.hasMore).toBe(false);
  expect((await rt.list_changes({feed:'memory',cursor:second.cursor}) as any).items).toEqual([]);
  await rm(c.memoryRoot,{recursive:true});await expect(rt.list_changes({feed:'memory',cursor:second.cursor})).rejects.toMatchObject({code:'FEED_RESET'});
}));

test('a failed write and competing edits cannot create partial memory revisions or feed events',()=>fixture(async(_root,c,rt)=>{
  const a=(await rt.write_memory(request())).memory;
  const db=new Database(join(c.memoryRoot,'memory.sqlite'));db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT,'injected failure'); END");db.close();
  await expect(rt.write_memory({...request('new'),id:a.id,expectedRevision:1})).rejects.toThrow('injected failure');
  expect((await rt.list_changes({feed:'memory'}) as any).items).toHaveLength(1);
  const repair=new Database(join(c.memoryRoot,'memory.sqlite'));repair.exec('DROP TRIGGER fail_insert');repair.close();
  const results=await Promise.allSettled([rt.write_memory({...request('left'),id:a.id,expectedRevision:1}),rt.write_memory({...request('right'),id:a.id,expectedRevision:1})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await rt.read_memory({id:a.id})).memory.revision).toBe(2);
}));

test('checked portable exports preserve history and retry receipts, reject corruption and never overwrite memories',()=>fixture(async(root,c,rt)=>{
  const input=request(),first=(await rt.write_memory(input)).memory;
  await rt.write_memory({...request('Updated preference'),id:first.id,expectedRevision:1});
  const path=join(root,'backup.json');expect((await exportMemory(c.memoryRoot,path)).revisions).toBe(2);
  expect((await stat(path)).mode&0o777).toBe(0o600);
  await expect(exportMemory(c.memoryRoot,path)).rejects.toMatchObject({code:'EEXIST'});
  const other=join(root,'restored');await restoreMemory(other,path);
  const restored=createRuntime({...c,memoryRoot:other});expect((await restored.read_memory({id:first.id,revision:1})).memory).toEqual(first);
  expect((await restored.write_memory(input)).replayed).toBe(true);
  await expect(restoreMemory(other,path)).rejects.toMatchObject({code:'MEMORY_NOT_EMPTY'});
  const feed=await rt.list_changes({feed:'memory'}) as any;
  expect((await restored.list_changes({feed:'memory'}) as any).streamId).not.toBe(feed.streamId);
  await expect(restored.list_changes({feed:'memory',cursor:feed.cursor})).rejects.toMatchObject({code:'FEED_RESET'});
  const backup=JSON.parse(await readFile(path,'utf8'));backup.entries[0].content.text='corrupted';await writeFile(path,JSON.stringify(backup));
  await expect(restoreMemory(join(root,'bad'),path)).rejects.toMatchObject({code:'INVALID_BACKUP'});
  const {checksum,...data}=backup;data.entries[1].revision=7;await writeFile(path,JSON.stringify({...data,checksum:hash(stableJson(data))}));
  await expect(restoreMemory(join(root,'bad'),path)).rejects.toMatchObject({code:'INVALID_BACKUP'});
  await expect(stat(join(root,'bad'))).rejects.toMatchObject({code:'ENOENT'});
}));

test('memory paths stay outside caches and do not follow directory links',()=>fixture(async(root,c)=>{
  expect(()=>configSchema.parse({...c,memoryRoot:c.libraryRoot})).toThrow('separate');
  expect(()=>configSchema.parse({...c,memoryRoot:join(c.libraryRoot,'memories')})).toThrow('separate');
  await mkdir(join(root,'real'));await symlink(join(root,'real'),join(root,'linked'));
  await expect(memoryStore(join(root,'linked')).write(writeMemorySchema.parse(request()),[])).rejects.toMatchObject({code:'UNSAFE_PATH'});
}));
