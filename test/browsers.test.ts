import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {safariBookmarks} from '../src/sources/browser/stores';
import {build,buildBinary} from 'plist';

async function temporary(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'ss-browsers-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('Firefox and Safari retain native visit identities, paginate profiles, filter dates and read current originals',()=>temporary(async root=>{
  const firefox=join(root,'firefox'),safari=join(root,'safari');await mkdir(firefox);await mkdir(safari);
  const ff=new Database(join(firefox,'places.sqlite'));
  ff.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY,title TEXT,url TEXT);
    CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,place_id INTEGER,visit_date INTEGER);
    CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,guid TEXT,type INTEGER,fk INTEGER,parent INTEGER,title TEXT,dateAdded INTEGER);
    INSERT INTO moz_places VALUES(1,'Invented observatory','https://example.test/observatory');
    INSERT INTO moz_historyvisits VALUES(1,1,1767225600000000),(2,1,1767312000000000);
    INSERT INTO moz_bookmarks VALUES(1,'folder-guid',2,NULL,0,'Research',NULL),(2,'bookmark-guid',1,1,1,'Telescope bookmark',1767225600000000);`);ff.close();
  const sf=new Database(join(safari,'History.db'));
  sf.exec(`CREATE TABLE history_items(id INTEGER PRIMARY KEY,url TEXT);CREATE TABLE history_visits(id INTEGER PRIMARY KEY,history_item INTEGER,visit_time REAL,title TEXT);
    INSERT INTO history_items VALUES(1,'https://example.test/observatory');INSERT INTO history_visits VALUES(1,1,788918400.5,'Invented observatory');`);sf.close();
  const c=configSchema.parse({enabledSources:['fox','apple','saved'],sources:{fox:{adapter:'firefox-history',profiles:[{id:'research',path:firefox}]},apple:{adapter:'safari-history',profiles:[{id:'personal',path:safari}]},saved:{adapter:'firefox-bookmarks',profiles:[{id:'research',path:firefox}]}}}),r=createRuntime(c);
  const first=(await r.search_sources({queries:[{source:'fox',query:'observatory',limit:1}]})).results[0]!;
  expect(first.items[0]!.occurredAt).toBe('2026-01-02T00:00:00.000Z');expect(first.nextCursor).toBeDefined();
  const second=(await r.search_sources({queries:[{source:'fox',query:'observatory',limit:1,cursor:first.nextCursor}]})).results[0]!;expect(second.items[0]!.ref.id).not.toBe(first.items[0]!.ref.id);
  expect((await r.read_record({ref:first.items[0]!.ref})).record.title).toBe('Invented observatory');
  const apple=(await r.search_sources({queries:[{source:'apple',query:'observatory',from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'}]})).results[0]!;
  expect(apple.items[0]!.occurredAt).toBe('2026-01-01T00:00:00.500Z');
  const bookmark=(await r.search_sources({queries:[{source:'all-bookmarks',query:'telescope',sort:'relevance'}]})).results[0]!.items[0]!;
  expect((await r.read_record({ref:bookmark.ref})).record.body).toContain('Folder: Research');
  const changed=new Database(join(firefox,'places.sqlite'));changed.exec("UPDATE moz_places SET title='Revised telescope';DELETE FROM moz_historyvisits WHERE id=1");changed.close();
  await expect(r.read_record({ref:first.items[0]!.ref})).rejects.toMatchObject({code:'STALE_RECORD'});
  await expect(r.read_record({ref:second.items[0]!.ref})).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  expect((await createRuntime({...c,enabledSources:[]}).search_sources({queries:[{source:'fox',query:''}]})).results[0]!.error?.code).toBe('SOURCE_DISABLED');
}));

test('Safari bookmark trees retain UUIDs and reject duplicate or malformed identities',()=>{
  const leaf={WebBookmarkType:'WebBookmarkTypeLeaf',WebBookmarkUUID:'saved-one',URLString:'https://example.test',URIDictionary:{title:'Invented bookmark'}};
  expect(safariBookmarks({Title:'Research',Children:[leaf]})).toEqual([{id:'saved-one',url:'https://example.test',title:'Invented bookmark',folder:'Research'}]);
  for(const tree of [{Children:[leaf,leaf]},{Children:[{...leaf,WebBookmarkUUID:undefined}]},{Children:'bad'}])expect(()=>safariBookmarks(tree)).toThrow();
});

test('Safari XML and binary bookmarks preserve dates and binary metadata without changing their files',()=>temporary(async root=>{
  const file=join(root,'Bookmarks.plist');
  const tree={Children:[{WebBookmarkType:'WebBookmarkTypeLeaf',WebBookmarkUUID:'saved-one',URLString:'https://example.test',URIDictionary:{title:'Invented bookmark'},ReadingList:{DateAdded:new Date('2026-01-01T00:00:00Z')},Sync:{ServerData:Buffer.from('invented cloud metadata')}}]};
  const c=configSchema.parse({enabledSources:['saved'],sources:{saved:{adapter:'safari-bookmarks',profiles:[{id:'personal',path:root}]}}});
  for(const binary of [false,true]){
    await writeFile(file,binary?buildBinary(tree):build(tree));
    if(binary&&process.platform==='darwin'){const child=Bun.spawn(['/usr/bin/plutil','-convert','binary1',file],{stdout:'ignore',stderr:'ignore'});expect(await child.exited).toBe(0);}
    const before=await Bun.file(file).arrayBuffer(),r=createRuntime(c),page=(await r.search_sources({queries:[{source:'saved',query:'invented'}]})).results[0]!;
    expect(page.items).toHaveLength(1);expect((await r.read_record({ref:page.items[0]!.ref})).record.body).toContain('https://example.test');
    expect(await Bun.file(file).arrayBuffer()).toEqual(before);
    expect((await r.search_sources({queries:[{source:'saved',query:'',from:'2026-01-01T00:00:00Z'}]})).results[0]!.error?.code).toBe('UNSUPPORTED_FILTER');
    expect((await r.search_sources({queries:[{source:'saved',query:'',sort:'newest'}]})).results[0]!.error?.code).toBe('UNSUPPORTED_FILTER');
    expect((await r.list_sources()).sources[0]!.capabilities.sort).toEqual(['relevance']);
  }
}));
