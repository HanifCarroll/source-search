import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {makeChunks,canonicalPassage} from '../src/search/library/projection';
import {publish,libraryDB,getState} from '../src/search/library/store';
import {readLibrary,searchLibrary} from '../src/search/library/index';
import {querySchema,type RecordData} from '../src/domain/contracts';
import {hash} from '../src/domain/identity';
import {defaultConfig} from './helpers/config';

const record:RecordData={ref:{source:'whatsapp',id:'fixture',version:'old-version'},title:'Invented meeting',body:'We meet on Tuesday.\nOriginal: {"quoted":"keep this prose"}',author:'Example',occurredAt:'2026-01-01T00:00:00Z',observedAt:'fixture',type:'message',locator:'fixture'};

test('clean search text preserves canonical bytes, user prose and offsets',()=>{
  const chunk=makeChunks('whatsapp',[record],{})[0]!;
  const original='# Invented meeting\n\nDerived search text. Source: whatsapp. Read original references before citing.\n\n## Invented meeting\nAuthor: Example\nDate: 2026-01-01T00:00:00Z\nOriginal: {"source":"whatsapp","id":"fixture","version":"old-version"}\n[primary]\n'+record.body;
  expect(chunk.body).toBe(original);expect(chunk.hash).toBe(hash(original));
  expect(chunk.searchText).not.toContain('Derived search text.');expect(chunk.searchText).not.toContain('old-version');
  expect(chunk.searchText).toContain(record.body);
  for(const span of chunk.searchSpans)expect(chunk.searchText.slice(span.start,span.end)).toBe(original.slice(span.canonicalStart,span.canonicalStart+span.end-span.start));
  const start=chunk.searchText.indexOf('Tuesday'),passage=canonicalPassage(chunk.searchSpans,start,start+7)!;
  expect(original.slice(passage.start,passage.end)).toBe('Tuesday');
});

test('search projection migration preserves saved refs, rejects stale indexes and remains incremental',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-clean-projection-'));
  const c={...defaultConfig(),libraryEnabled:true,libraryRoot:root,libraryDatabase:join(root,'qmd.sqlite')};
  try{
    await publish(c,'whatsapp',[record],{},{state:'ready'});
    const chunk=makeChunks('whatsapp',[record],{})[0]!,path=join(root,'collections/ss-whatsapp',chunk.id+'.md');
    // Recreate the on-disk representation of the previous release.
    let db=libraryDB(c,true);db.exec('DROP TABLE chunk_search');db.close();await writeFile(path,chunk.body);
    const ref={source:'library',id:chunk.id,version:chunk.hash};
    const before=await readLibrary(c,ref,async()=>{});
    const index=new Database(c.libraryDatabase);index.exec('CREATE TABLE documents(collection,path,hash,active); CREATE TABLE content_vectors(hash)');
    index.query('INSERT INTO documents VALUES(?,?,?,1)').run('ss-whatsapp',chunk.id+'.md',chunk.hash);
    const query=querySchema.parse({source:'library',query:'Tuesday',mode:'lexical'});
    const retrieve=()=>searchLibrary(c,query,async()=>[{file:'qmd://ss-whatsapp/'+chunk.id+'.md',score:1,snippet:'Tuesday'}]);
    expect((await retrieve()).items).toHaveLength(1);
    await publish(c,'whatsapp',[record],{},{state:'ready'});
    expect((await readLibrary(c,ref,async()=>{})).body).toBe(before.body);
    expect(await readFile(path,'utf8')).toBe(chunk.searchText);
    expect((await retrieve()).items).toHaveLength(1);
    index.query('UPDATE documents SET hash=?').run('unrelated-stale-body');
    expect((await retrieve()).items).toHaveLength(0);
    index.query('UPDATE documents SET hash=?').run(chunk.searchHash);
    expect((await retrieve()).items[0]!.ref).toEqual(ref);
    const stamp=(await stat(path)).mtimeMs;
    db=libraryDB(c);const state=getState(db,'whatsapp');db.close();
    await publish(c,'whatsapp',[record],{},{state:'ready'});
    db=libraryDB(c);expect(getState(db,'whatsapp').projectionRevision).toBe(state.projectionRevision);db.close();
    expect((await stat(path)).mtimeMs).toBe(stamp);
    await publish(c,'whatsapp',[],{});db=libraryDB(c);expect(db.query('SELECT count(*) n FROM chunk_search').get()).toEqual({n:0});db.close();index.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
