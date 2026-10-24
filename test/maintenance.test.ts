import {test,expect} from 'bun:test';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/platform/config';
import {syncSources,syncTasks} from '../src/maintenance/sources';
import {publishSnapshots,syncLibrary} from '../src/maintenance/library-sync';
import {snapshotStore} from '../src/sources/sync/cache';
import {libraryDB,getState} from '../src/search/library/store';
import {createRuntime} from '../src/application/runtime';

async function fixture(fn:(c:ReturnType<typeof configSchema.parse>,file:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'ss-maintenance-')),file=join(root,'tasks.json');
 try{
  await writeFile(file,JSON.stringify({version:1,tasks:[{id:'one',title:'Invented optics',description:'Calibrate the telescope'}]}));
  const c=configSchema.parse({maintenanceEnabled:true,enabledSources:['todo'],libraryRoot:join(root,'cache'),libraryDatabase:join(root,'rank.sqlite'),sources:{todo:{adapter:'tasks',connector:{type:'json',paths:[file]}}}});
  await fn(c,file);
 }finally{await rm(root,{recursive:true,force:true});}
}

test('unified sync works without library or models; enabling the library keeps saved references',()=>fixture(async(c)=>{
 expect((await syncSources(c)).ok).toBe(true);
 const runtime=createRuntime(c),page=(await runtime.search_sources({queries:[{source:'todo',query:'optics'}]})).results[0]!;
 const ref=page.items[0]!.ref;
 expect((await runtime.read_record({ref})).record.body).toContain('telescope');
 await expect(access(join(c.libraryRoot,'library.sqlite'))).rejects.toMatchObject({code:'ENOENT'});
 const withLibrary={...c,libraryEnabled:true,enabledSources:['todo','library']};
 await publishSnapshots(withLibrary);
 expect((await createRuntime(withLibrary).read_record({ref})).record.ref).toEqual(ref);
 const db=libraryDB(c);try{expect(getState(db,'todo')).toMatchObject({state:'ready',records:1});}finally{db.close();}
}));

test('library failure cannot roll back a committed source checkpoint or prevent the next sync',()=>fixture(async(c,file)=>{
 const enabled={...c,libraryEnabled:true,enabledSources:['todo','library']};
 await syncSources(enabled);await publishSnapshots(enabled);
 const db=join(c.libraryRoot,'library.sqlite');await rm(db);await writeFile(db,'broken fixture');
 await writeFile(file,JSON.stringify({version:1,tasks:[{id:'two',title:'Invented new task'}]}));
 expect((await syncSources(enabled)).ok).toBe(true);
 const store=snapshotStore(c,'todo'),before=await store.read();
 await expect(publishSnapshots(enabled)).rejects.toThrow();
 expect(await store.read()).toEqual(before);
 expect((await store.read())!.records[0]!.ref.id).toBe('two');
 expect((await syncSources(enabled)).ok).toBe(true);
}));

test('projection uses committed snapshots and retains failure evidence until a successful sync',()=>fixture(async(c,file)=>{
 const enabled={...c,libraryEnabled:true,enabledSources:['todo','library']};
 await syncSources(c);await publishSnapshots(enabled);
 let db=libraryDB(c);const revision=getState(db,'todo').projectionRevision;db.close();
 // No second provider read while projecting, even if the original is now offline.
 await rm(file);await syncLibrary(enabled,{refreshSources:false});
 db=libraryDB(c);expect(getState(db,'todo').projectionRevision).toBe(revision);db.close();
 expect((await syncSources(c)).ok).toBe(false);await publishSnapshots(enabled);
 db=libraryDB(c);expect(getState(db,'todo')).toMatchObject({state:'error',records:1,projectionRevision:revision});db.close();
 await writeFile(file,JSON.stringify({version:1,tasks:[]}));
 expect((await syncSources(c)).ok).toBe(true);await publishSnapshots(enabled);
 db=libraryDB(c);try{
  expect(getState(db,'todo')).toMatchObject({state:'ready',records:0,error:null});
  expect(db.query('SELECT id FROM chunks').all()).toEqual([]);
 }finally{db.close();}
}));

test('one failed provider does not prevent other selected sources syncing; disabled sources stay untouched',()=>fixture(async(c)=>{
 const config=configSchema.parse({...c,enabledSources:['todo','agenda'],sources:{...c.sources,agenda:{adapter:'calendars',connector:{type:'google',account:'invented',token:{env:'UNUSED'}}},off:{adapter:'calendars',connector:{type:'google',account:'other',token:{env:'UNUSED'}}}}});
 const called:string[]=[];
 const result=await syncSources(config,undefined,(_c,source)=>({
  async sync(){called.push(source);if(source==='todo')throw Error('Invented disconnect');return {records:[],checkpoint:'next',coverage:'Empty invented calendar',strategy:'fixture',warnings:[]};},
  async read(){throw Error('Not used');}
 }));
 expect(result.ok).toBe(false);expect(called).toEqual(['todo','agenda']);
 expect((await snapshotStore(config,'agenda').read())!.checkpoint).toBe('next');
 await expect(syncSources(config,'off')).rejects.toMatchObject({code:'SOURCE_DISABLED'});
 await expect(syncTasks(config,'agenda')).rejects.toMatchObject({code:'INVALID_SOURCE'});
}));
