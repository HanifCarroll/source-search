import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from './helpers/config';
import {createRuntime} from '../src/application/runtime';
import {readMail} from '../src/sources/mail/index';
import {publish,libraryDB} from '../src/search/library/store';
import {runQmd} from '../src/search/qmd/runner';
import {hash} from '../src/domain/identity';
import {canTrimItems} from '../src/domain/source-policy';
import {querySchema} from '../src/domain/contracts';

test('library freshness checks do not depend on whether the full original fits a response',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-original-boundary-'));
 try{
  const c={...defaultConfig(),libraryEnabled:true,libraryRoot:root};
  let subject='Invented subject '.repeat(5000);
  const execute=async()=>({headers:{subject,from:'fixture@example.test',date:'2026-01-01T00:00:00Z'},message:{id:'fixture',threadId:'fixture',internalDate:'1767225600000'},body:'An invented short statement.'});
  const original=await readMail('mail-personal','fixture',execute,c);
  await publish(c,'mail-personal',[original],{mail:'mail-personal',accountSignature:hash(JSON.stringify(c.mailAccounts['mail-personal']))});
  const db=libraryDB(c),row=db.query('SELECT id,hash FROM chunks').get() as {id:string;hash:string};db.close();
  const runtime=createRuntime(c,execute),ref={source:'library',id:row.id,version:row.hash};
  await expect(runtime.read_record({ref:original.ref})).rejects.toMatchObject({code:'OUTPUT_LIMIT'});
  expect((await runtime.read_record({ref})).record.body).toContain('An invented short statement.');
  subject='Changed original';
  await expect(runtime.read_record({ref})).rejects.toMatchObject({code:'STALE_RECORD'});
  const disabled=createRuntime({...c,enabledSources:c.enabledSources.filter(s=>s!=='mail-personal')},execute);
  await expect(disabled.read_record({ref})).rejects.toMatchObject({code:'SOURCE_DISABLED'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('continuation policy follows the retrieval engine for projected mail',()=>{
 const q=querySchema.parse({source:'mail-personal',query:'fixture'});
 expect(canTrimItems(q)).toBe(false);
 expect(canTrimItems({...q,mode:'lexical'})).toBe(false);
 expect(canTrimItems({...q,mode:'semantic'})).toBe(true);
 expect(canTrimItems({...q,mode:'hybrid'})).toBe(true);
});

test('QMD runner builds literal CLI requests and chooses hybrid databases by target',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-runner-boundary-'));
 try{
  const binary=join(root,'synthetic-qmd');
  await writeFile(binary,`#!${process.execPath}\nconst args=process.argv.slice(2);console.log(JSON.stringify(args.includes('--eval')?JSON.parse(await Bun.stdin.text()):args));\n`,{mode:0o700});
  const c={...defaultConfig(),qmdBinary:binary,nodeBinary:binary,qmdIndex:'same-name',libraryIndex:'same-name',qmdDatabase:join(root,'vault.sqlite'),libraryDatabase:join(root,'library.sqlite')};
  const query='--option "quoted" $(literal)';
  for(const [mode,command] of [['lexical','search'],['semantic','vsearch']] as const){
   expect(await runQmd({index:'library',mode,query,collection:'ss-whatsapp'},c)).toEqual([binary,'--index','same-name',command,'--json','-n','100','-c','ss-whatsapp','--',query].slice(1));
  }
  expect(await runQmd({index:'vault',mode:'hybrid',query},c)).toMatchObject({database:c.qmdDatabase,query});
  expect(await runQmd({index:'library',mode:'hybrid',query,collection:'ss-whatsapp'},c)).toMatchObject({database:c.libraryDatabase,query,collection:'ss-whatsapp'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('shared SQLite snapshots include WAL data, remain stable, reject writes and clean up',async()=>{
 const {Database}=await import('bun:sqlite');
 const {createSnapshot}=await import('../src/platform/sqlite');
 const {readFile,access}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'ss-snapshot-')),path=join(root,'source.sqlite');
 const original=new Database(path);let snapshot:Awaited<ReturnType<typeof createSnapshot>>|undefined;
 try{
  original.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES('first');");
  const before=await readFile(path),walBefore=await readFile(path+'-wal');
  snapshot=await createSnapshot(path);
  expect(await readFile(path)).toEqual(before);expect(await readFile(path+'-wal')).toEqual(walBefore);
  expect(snapshot.database.query('SELECT value FROM entries').all()).toEqual([{value:'first'}]);
  expect(()=>snapshot!.database.exec("INSERT INTO entries VALUES('forbidden')")).toThrow();
  original.exec("INSERT INTO entries VALUES('second')");
  expect(snapshot.database.query('SELECT value FROM entries').all()).toEqual([{value:'first'}]);
  const copy=(snapshot.database.query('PRAGMA database_list').get() as {file:string}).file;
  await snapshot.close();snapshot=undefined;
  await expect(access(copy)).rejects.toMatchObject({code:'ENOENT'});
  expect(original.query('SELECT value FROM entries').all()).toEqual([{value:'first'},{value:'second'}]);
 }finally{await snapshot?.close();original.close();await rm(root,{recursive:true,force:true});}
});
