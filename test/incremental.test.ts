import {getMailState as getState,setMailState as setState} from '../src/platform/cache-state';
import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,stat,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {installSearchRevision} from '../src/vendor/qmd/revisions';
import {cachedSearch,indexRevision} from '../src/search/qmd/cache';
import {projectionHealth} from '../src/search/library/index';
import {textFile} from '../src/platform/source-files';
import {runSdk,disposeSearchWorkers} from '../src/search/qmd/runner';
afterEach(disposeSearchWorkers);
import {configSchema} from '../src/platform/config';
import {rebuildArchive} from '../src/sources/archives/index';
import {createZip} from './helpers/zip';
import type {RecordData} from '../src/domain/contracts';
import {syncMail} from '../src/maintenance/library-sync';
import {libraryDB,publish} from '../src/search/library/store';

async function temporary(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-incremental-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('ranked cache coalesces work, survives reopening, and invalidates changes and scopes',()=>temporary(async root=>{
  const path=join(root,'index.sqlite'),db=new Database(path);
  db.exec('CREATE TABLE documents(id,title,hash,active,collection,path,modified_at); CREATE TABLE content_vectors(hash,seq)');installSearchRevision(db);
  db.exec("INSERT INTO documents VALUES(1,'Fixture','v1',1,'notes','a.md','old')");
  let calls=0;const search=async()=>{calls++;await Bun.sleep(10);return [{file:'a.md',score:1}];};
  const query={query:'fixture',mode:'hybrid',scope:'team'};
  await Promise.all([cachedSearch(path,query,search),cachedSearch(path,query,search)]);expect(calls).toBe(1);
  const first=await indexRevision(path);db.exec("UPDATE documents SET modified_at='new'");expect(await indexRevision(path)).toBe(first);
  await cachedSearch(path,query,search);expect(calls).toBe(1);
  db.exec("UPDATE documents SET hash='v2'");await cachedSearch(path,query,search);expect(calls).toBe(2);
  db.exec("INSERT INTO content_vectors VALUES('v2',0)");await cachedSearch(path,query,search);expect(calls).toBe(3);
  await cachedSearch(path,{...query,scope:'other-account'},search);expect(calls).toBe(4);
  await cachedSearch(path,{...query,model:'different'},search);expect(calls).toBe(5);
  const permissions=(await stat(path+'.search-cache.sqlite')).mode&0o777;expect(permissions).toBe(0o600);
  db.exec('DELETE FROM documents');await cachedSearch(path,query,search);expect(calls).toBe(6);db.close();
}));
test('failed and concurrently invalidated searches never become cached results',()=>temporary(async root=>{
  const path=join(root,'index.sqlite'),db=new Database(path);db.exec('CREATE TABLE documents(id,title,hash,active,collection,path); CREATE TABLE content_vectors(hash)');installSearchRevision(db);
  let calls=0;await expect(cachedSearch(path,'q',async()=>{throw Error('failed');})).rejects.toThrow('failed');
  await cachedSearch(path,'q',async()=>{calls++;db.exec("INSERT INTO content_vectors VALUES('new')");return [];});
  await cachedSearch(path,'q',async()=>{calls++;return [];});expect(calls).toBe(2);db.close();
}));
test('unchanged SDK refresh preserves ranked cache, while edits and removals invalidate it',()=>temporary(async root=>{
  const notes=join(root,'notes');await mkdir(notes);await writeFile(join(notes,'one.md'),'# Cobalt\n\nCobalt fixture.');
  const c=configSchema.parse({qmdDatabase:join(root,'index.sqlite'),qmdRoots:{notes}});
  await runSdk(c,{index:'vault',action:'update'});
  expect(await runSdk(c,{index:'vault',mode:'lexical',query:'cobalt'})).toHaveLength(1);
  const revision=await indexRevision(c.qmdDatabase),db=new Database(c.qmdDatabase,{create:false,strict:true});
  db.query('INSERT OR REPLACE INTO llm_cache(hash,result,created_at) VALUES(?,?,?)').run('fixture','retained',new Date().toISOString());db.close();
  await runSdk(c,{index:'vault',action:'update'});expect(await indexRevision(c.qmdDatabase)).toBe(revision);
  const checked=new Database(c.qmdDatabase,{create:false,strict:true});expect(checked.query("SELECT result FROM llm_cache WHERE hash='fixture'").get()).toEqual({result:'retained'});checked.close();
  await writeFile(join(notes,'one.md'),'# Amber\n\nAmber fixture.');await runSdk(c,{index:'vault',action:'update'});
  expect(await runSdk(c,{index:'vault',mode:'lexical',query:'cobalt'})).toHaveLength(0);
  expect(await runSdk(c,{index:'vault',mode:'lexical',query:'amber'})).toHaveLength(1);
  await rm(join(notes,'one.md'));await runSdk(c,{index:'vault',action:'update'});
  expect(await runSdk(c,{index:'vault',mode:'lexical',query:'amber'})).toHaveLength(0);
}),15000);
test('unchanged library publications skip indexing, and changed projections are indexed',()=>temporary(async root=>{
  const c=configSchema.parse({enabledSources:['library','whatsapp'],libraryEnabled:true,libraryRoot:root,libraryDatabase:join(root,'index.sqlite')});
  const r:RecordData={ref:{source:'whatsapp',id:'1',version:'v1'},title:'Fixture',body:'Cobalt',type:'message',locator:'fixture',observedAt:'fixture'};
  await publish(c,'whatsapp',[r],{},{state:'ready'});await runSdk(c,{index:'library',action:'update'});
  await publish(c,'whatsapp',[r],{},{state:'ready'});expect(await runSdk(c,{index:'library',action:'update'})).toMatchObject({reused:true});
  await publish(c,'whatsapp',[{...r,body:'Amber',ref:{...r.ref,version:'v2'}}],{},{state:'ready'});
  expect(await runSdk(c,{index:'library',action:'update'})).toMatchObject({updated:1});
  expect(await runSdk(c,{index:'library',mode:'lexical',query:'amber'})).toHaveLength(1);
}),15000);
test('coverage distinguishes initial backfill, refresh, stale data, and real failures',()=>{
  const at=Date.parse('2026-01-01T12:00:00Z'),lastCompleteScan='2026-01-01T11:59:00Z';
  expect(projectionHealth({state:'backfilling'},true,at)).toMatchObject({state:'backfilling',initialBackfillComplete:false});
  expect(projectionHealth({state:'backfilling',lastCompleteScan},true,at)).toMatchObject({state:'ready',activity:'refreshing',initialBackfillComplete:true});
  expect(projectionHealth({state:'ready',lastCompleteScan:'2026-01-01T10:00:00Z'},true,at)).toMatchObject({state:'stale',freshness:{stale:true}});
  expect(projectionHealth({state:'error',lastCompleteScan},true,at).state).toBe('error');
  expect(projectionHealth({state:'ready',failedFiles:1},false,at).state).toBe('error');
});
test('small live text reuse detects edits, atomic replacement, deletion and read limits',()=>temporary(async root=>{
  const path=join(root,'fixture.md');await writeFile(path,'first');expect(await textFile(path)).toBe('first');
  await writeFile(path,'other');expect(await textFile(path)).toBe('other');
  await writeFile(path+'.new','third');await rename(path+'.new',path);expect(await textFile(path)).toBe('third');
  await expect(textFile(path,1)).rejects.toMatchObject({code:'SOURCE_LIMIT'});await rm(path);await expect(textFile(path)).rejects.toMatchObject({code:'ENOENT'});
}));
test('archive refresh reuses unchanged sources and commits changed records without replacing the database',()=>temporary(async root=>{
  const path=join(root,'export.zip'),c=configSchema.parse({enabledSources:['takeout-archive'],maintenanceEnabled:true,takeout:[path],index:join(root,'exports.sqlite')});
  const write=(name:string)=>createZip([{path:'Takeout/Calendar/Fixture.ics',text:`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20260101T000000Z\r\nSUMMARY:${name}\r\nEND:VEVENT\r\nEND:VCALENDAR`}]).then(bytes=>writeFile(path,bytes));
  await write('Cobalt');const initial=await rebuildArchive(c),inode=(await stat(c.index)).ino;
  expect(initial.changedRecords).toBeGreaterThan(0);expect((await rebuildArchive(c)).changedRecords).toBe(0);
  await write('Amber');expect((await rebuildArchive(c)).changedRecords).toBeGreaterThan(0);expect((await stat(c.index)).ino).toBe(inode);
  const db=new Database(c.index,{readonly:true});expect(JSON.stringify(db.query('SELECT body FROM records').all())).toContain('Amber');db.close();
}));
test('Gmail uses additions history between full reconciliations, then catches deletions and label changes',()=>temporary(async root=>{
  await mkdir(join(root,'mail-raw'),{mode:0o700});
  const c=configSchema.parse({libraryRoot:root,maintenanceEnabled:true,libraryEnabled:true,enabledSources:['inbox'],sources:{inbox:{adapter:'gmail',account:'invented',email:'fixture@example.test'}}});
  let ids=['alpha','bravo'],history='100',changed:string[]=[],searches=0,reads:string[]=[];
  const execute=async(args:string[])=>{
    if(args.includes('history'))return {historyId:history,messages:changed,nextPageToken:''};
    if(args.includes('search')){searches++;return {messages:ids.map(id=>({id,subject:id,from:'fixture@example.test',date:'2026-01-01 00:00',labels:[]}))};}
    const id=args[args.indexOf('get')+1]!;reads.push(id);return {headers:{subject:id,from:'fixture@example.test',date:'2026-01-01T00:00:00Z'},message:{id,historyId:history,threadId:id,internalDate:'1767225600000',labelIds:[]},body:'Invented '+id};
  };
  const due=(age=0)=>{const db=libraryDB(c,true);setState(db,'inbox',{...getState(db,'inbox'),nextScanAt:0,...(age?{lastCompleteScan:new Date(Date.now()-age).toISOString()}:{} )});db.close();};
  await syncMail(c,execute,['inbox']);let db=libraryDB(c);expect(getState(db,'inbox').gmailHistory).toBe('100');db.close();searches=0;reads=[];
  changed=['charlie'];history='101';due();await syncMail(c,execute,['inbox']);expect(searches).toBe(0);expect(reads).toEqual(['charlie']);
  db=libraryDB(c);expect((db.query('SELECT count(*) n FROM mail').get() as any).n).toBe(3);db.close();
  changed=[];due();reads=[];await syncMail(c,execute,['inbox']);expect(reads).toEqual([]);expect(searches).toBe(0);
  ids=['bravo','charlie'];due(86400001);await syncMail(c,execute,['inbox']);expect(searches).toBeGreaterThan(0);
  db=libraryDB(c);expect((db.query('SELECT id FROM mail ORDER BY id').all() as any[]).map(r=>r.id)).toEqual(['bravo','charlie']);db.close();
}));
