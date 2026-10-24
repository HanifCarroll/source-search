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

test('closed WAL databases can be read without creating sidecars beside the source',async()=>{
 const {Database}=await import('bun:sqlite');const {createSnapshot}=await import('../src/platform/sqlite');
 const {readFile,readdir}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'ss-closed-wal-')),path=join(root,'source.sqlite');
 try{
  const db=new Database(path);db.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES('retained'); PRAGMA wal_checkpoint(TRUNCATE);");db.close();
  await rm(path+'-wal',{force:true});await rm(path+'-shm',{force:true});
  const before=await readFile(path);expect(await readdir(root)).toEqual(['source.sqlite']);
  const snapshot=await createSnapshot(path);try{
   expect(snapshot.database.query('SELECT value FROM entries').all()).toEqual([{value:'retained'}]);
   expect(()=>snapshot.database.exec("INSERT INTO entries VALUES('forbidden')")).toThrow();
  }finally{await snapshot.close();}
  expect(await readdir(root)).toEqual(['source.sqlite']);expect(await readFile(path)).toEqual(before);
 }finally{await rm(root,{recursive:true,force:true});}
});
