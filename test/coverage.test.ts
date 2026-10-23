import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from './helpers/config';
import {createRuntime} from '../src/application/runtime';
import {allDatabaseRecords} from '../src/sources/local/databases';
import {makeChunks,publish,libraryDB,getState} from '../src/search/library/store';
import {syncLibrary,stampPaths} from '../src/maintenance/library-sync';

test('WhatsApp photo and video captions participate in search, reads, context and library text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-caption-')),c={...defaultConfig(),whatsapp:join(root,'whatsapp.sqlite'),libraryRoot:join(root,'library'),index:join(root,'archive.sqlite'),libraryEnabled:true,maintenanceEnabled:true,enabledSources:['whatsapp' as const,'library' as const]};
 try{
  const db=new Database(c.whatsapp);
  db.exec("CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER,ZMESSAGETYPE INTEGER);CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER,ZTITLE TEXT);INSERT INTO ZWACHATSESSION VALUES(1,'fixture','Fixture conversation');INSERT INTO ZWAMEDIAITEM VALUES(1,'Invented violet comet'),(2,'Invented amber river');INSERT INTO ZWAMESSAGE VALUES(1,1,'photo',700000000,0,NULL,'friend',1,1),(2,1,'video',700000001,0,NULL,'friend',2,2);");db.close();const before=await readFile(c.whatsapp);
  const rt=createRuntime(c),page=(await rt.search_sources({queries:[{source:'whatsapp',query:'violet'}]})).results[0];
  expect(page.items).toHaveLength(1);
  const read=await rt.read_record({ref:page.items[0]!.ref,context:true});
  expect(read.record.body).toContain('Invented violet comet');
  expect(read.record.metadata?.textOrigin).toBe('media-caption');
  expect(JSON.stringify(read.context)).toContain('Invented amber river');
  const all=await allDatabaseRecords(c,'whatsapp');
  expect(makeChunks('whatsapp',all,{}).map(r=>r.body).join('\n')).toContain('Invented violet comet');
  await publish(c,'whatsapp',all.map(r=>({...r,body:''})),{}, {state:'ready',signature:await stampPaths([c.whatsapp,c.whatsapp+'-wal']),projectionVersion:1});
  await syncLibrary(c);
  const cached=libraryDB(c);
  try{
   expect(getState(cached,'whatsapp')).toMatchObject({projectionVersion:2,textRecords:2,state:'ready'});
   expect((cached.query("SELECT body FROM chunks WHERE source='whatsapp'").all() as {body:string}[]).map(r=>r.body).join('\n')).toContain('Invented violet comet');
  }finally{cached.close();}
  expect(await readFile(c.whatsapp)).toEqual(before);
  const changed=new Database(c.whatsapp);changed.exec("UPDATE ZWAMEDIAITEM SET ZTITLE='Changed caption' WHERE Z_PK=1");changed.close();
  await expect(rt.read_record({ref:page.items[0]!.ref})).rejects.toMatchObject({code:'STALE_RECORD'});

 }finally{await rm(root,{recursive:true,force:true});}
});

test('WhatsApp does not index document filenames or link preview titles as captions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-caption-types-')),c={...defaultConfig(),whatsapp:join(root,'whatsapp.sqlite')};
 try{
  const db=new Database(c.whatsapp);
  db.exec("CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER,ZMESSAGETYPE INTEGER);CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER,ZTITLE TEXT);INSERT INTO ZWACHATSESSION VALUES(1,'fixture','Fixture conversation');INSERT INTO ZWAMEDIAITEM VALUES(1,'Invented book.epub'),(2,'Unrelated preview title'),(3,'Same caption'),(4,'GIF caption');INSERT INTO ZWAMESSAGE VALUES(1,1,'document',700000000,0,NULL,'friend',1,8),(2,1,'link',700000001,0,'Authored link text','friend',2,7),(3,1,'photo',700000002,0,'Same caption','friend',3,1),(4,1,'gif',700000003,0,NULL,'friend',4,11);");db.close();
  const all=await allDatabaseRecords(c,'whatsapp');
  expect(all.map(r=>r.body)).toEqual(['','Authored link text','Same caption','Media caption\nGIF caption']);
  expect(makeChunks('whatsapp',all,{}).map(r=>r.body).join('\n')).not.toContain('book.epub');
 }finally{await rm(root,{recursive:true,force:true});}
});
