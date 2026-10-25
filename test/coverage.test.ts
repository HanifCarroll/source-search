import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from './helpers/config';
import {createRuntime} from '../src/application/runtime';
import {allDatabaseRecords} from '../src/sources/local/databases';
import {makeChunks,publish,libraryDB,getState} from '../src/search/library/store';
import {syncLibrary} from '../src/maintenance/library-sync';
import {stamp as stampPaths} from '../src/maintenance/direct/model';

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
   expect(getState(cached,'whatsapp')).toMatchObject({projectionVersion:4,textRecords:2,state:'ready'});
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

import {Writer} from 'protobufjs/minimal';
test('WhatsApp polls and contact cards survive search, original reads, context and cache migration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-structured-')),c={...defaultConfig(),whatsapp:join(root,'whatsapp.sqlite'),libraryRoot:join(root,'library'),index:join(root,'archive.sqlite'),libraryEnabled:true,maintenanceEnabled:true,enabledSources:['whatsapp' as const,'library' as const]};
 try{
  const db=new Database(c.whatsapp);
  db.exec("CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZCHATSESSION INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZISFROMME INTEGER,ZTEXT TEXT,ZFROMJID TEXT,ZMEDIAITEM INTEGER,ZMESSAGETYPE INTEGER,ZMESSAGEINFO INTEGER);CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER,ZVCARDSTRING TEXT);CREATE TABLE ZWAMESSAGEINFO(Z_PK INTEGER,ZRECEIPTINFO BLOB);INSERT INTO ZWACHATSESSION VALUES(1,'fixture','Fixture chat');INSERT INTO ZWAMESSAGE VALUES(1,1,'poll',700000000,0,NULL,'friend',NULL,46,1),(2,1,'contact',700000001,0,NULL,'friend',2,4,NULL),(3,1,'media',700000002,0,NULL,'friend',2,1,NULL),(4,1,'badpoll',700000003,0,NULL,'friend',NULL,46,4);");
  const poll=Writer.create().uint32(18).string('Invented picnic').uint32(26).bytes(Writer.create().uint32(10).string('Violet park').finish()).finish();
  db.query('INSERT INTO ZWAMESSAGEINFO VALUES(?,?)').run(1,Writer.create().uint32(66).bytes(poll).finish());db.query('INSERT INTO ZWAMESSAGEINFO VALUES(?,?)').run(4,new Uint8Array([66,255]));
  db.query('INSERT INTO ZWAMEDIAITEM VALUES(?,?)').run(2,'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Fixture Astronaut\r\nTEL:+15550102030\r\nEND:VCARD');db.close();
  const original=await readFile(c.whatsapp),records=await allDatabaseRecords(c,'whatsapp');
  expect(records[2]!.body).toBe('');expect(records[3]!.warnings?.some(w=>w.includes('could not be decoded'))).toBe(true);
  await publish(c,'whatsapp',records.map(r=>({...r,body:''})),{}, {state:'ready',signature:await stampPaths([c.whatsapp,c.whatsapp+'-wal']),projectionVersion:2});
  await syncLibrary(c);const cache=libraryDB(c);
  try{expect(getState(cache,'whatsapp')).toMatchObject({projectionVersion:4,textRecords:2});expect(JSON.stringify(cache.query("SELECT body FROM chunks WHERE source='whatsapp'").all())).toContain('Fixture Astronaut');}finally{cache.close();}
  const runtime=createRuntime(c);
  for(const query of ['Violet park','Fixture Astronaut','15550102030']){
   const result=(await runtime.search_sources({queries:[{source:'whatsapp',query}]})).results[0]!;expect(result.items).toHaveLength(1);
   const read=await runtime.read_record({ref:result.items[0]!.ref,context:true});expect(read.record.body).toContain(query);expect(JSON.stringify(read.context)).toContain(query==='Violet park' ? 'Fixture Astronaut' : 'Invented picnic');
  }
  expect(await readFile(c.whatsapp)).toEqual(original);
 }finally{await rm(root,{recursive:true,force:true});}
});

import {createZip} from './helpers/zip';
import {writeFile} from 'node:fs/promises';
import {setState} from '../src/search/library/store';
test('archive parser version changes republish library text when source bytes are unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-archive-format-')),c={...defaultConfig(),takeout:[join(root,'fixture.zip')],libraryRoot:join(root,'library'),index:join(root,'archive.sqlite'),libraryEnabled:true,maintenanceEnabled:true,enabledSources:['takeout-archive' as const,'library' as const]};
 try{
  await writeFile(c.takeout[0]!,await createZip([{path:'Takeout/Calendar/Fixture.ics',text:'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20240101T000000Z\r\nSUMMARY:Violet fixture\r\nEND:VEVENT\r\nEND:VCALENDAR'}]));
  await syncLibrary(c);let db=libraryDB(c,true);const current=getState(db,'takeout-archive');db.exec("UPDATE chunks SET body='Old projection' WHERE source='takeout-archive'");setState(db,'takeout-archive',{...current,projectionVersion:2});db.close();
  await syncLibrary(c);db=libraryDB(c);try{expect(getState(db,'takeout-archive').projectionVersion).toBe(4);expect(JSON.stringify(db.query('SELECT body FROM chunks').all())).toContain('Violet fixture');}finally{db.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
