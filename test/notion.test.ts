import {test,expect} from 'bun:test';
import {notionProvider} from '../src/sources/notes/notion';
import {configSchema} from '../src/platform/config';
import {sourceGroups} from '../src/platform/source-settings';

const id='11111111-1111-4111-8111-111111111111',dataSource='22222222-2222-4222-8222-222222222222',subtree='33333333-3333-4333-8333-333333333333';
const page={object:'page',id,last_edited_time:'2026-10-24T12:00:00Z',created_time:'2026-10-01T12:00:00Z',url:'https://app.notion.com/p/'+id,parent:{data_source_id:dataSource},properties:{Name:{type:'title',title:[{plain_text:'Invented observatory'}]},Status:{type:'status',status:{name:'Planning'}}}};
test('Notion traverses opaque pagination, reuses unchanged content, refreshes edits and removes missing data-source rows',async()=>{
  let phase=0,reads=0;
  const provider=notionProvider('knowledge',{pages:[],dataSources:[dataSource]},async(path,body)=>{
    if(path.endsWith('/query')){if(phase===2)return {results:[],has_more:false,next_cursor:null};return body?.start_cursor?{results:[{...page,last_edited_time:phase?'2026-10-24T13:00:00Z':page.last_edited_time}],has_more:false,next_cursor:null}:{results:[],has_more:true,next_cursor:'opaque:session:next'};}
    if(path.endsWith('/markdown')){reads++;return {id,markdown:phase?'Changed telescope details':'Original telescope details',truncated:false,unknown_block_ids:[]};}
    return page;
  });
  const first=await provider.sync();expect(first.records[0]!.body).toContain('Status: Planning');
  expect((await provider.sync(first.checkpoint)).records[0]!.ref.version).toBe(first.records[0]!.ref.version);expect(reads).toBe(1);
  phase=1;const changed=await provider.sync(first.checkpoint);expect(changed.records[0]!.body).toContain('Changed telescope');expect(changed.records[0]!.ref.version).not.toBe(first.records[0]!.ref.version);
  phase=2;expect((await provider.sync(changed.checkpoint)).records).toEqual([]);
});
test('Notion completes truncated subtrees, reports inaccessible blocks and enforces current page selection',async()=>{
  let moved=false;
  const provider=notionProvider('knowledge',{pages:[],dataSources:[dataSource]},async path=>{
    if(path===`/pages/${id}`)return {...page,parent:{data_source_id:moved?'elsewhere':dataSource}};
    if(path===`/pages/${id}/markdown`)return {id,markdown:'Main text',truncated:true,unknown_block_ids:[subtree]};
    return {id:subtree,markdown:'Nested constellation notes',truncated:false,unknown_block_ids:[]};
  });
  expect((await provider.read(id)).body).toContain('Nested constellation notes');
  moved=true;await expect(provider.read(id)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  const incomplete=notionProvider('knowledge',{pages:[id],dataSources:[]},async path=>path.endsWith('/markdown')?{id,markdown:'Partial',truncated:true,unknown_block_ids:[]}:page);
  await expect(incomplete.sync()).rejects.toMatchObject({code:'INCOMPLETE_SOURCE'});
});
test('new notes adapter does not reserve existing notes IDs and groups both local and cloud notes',()=>{
  const c=configSchema.parse({sources:{notes:{adapter:'markdown',root:'/invented/notes'},knowledge:{adapter:'notes',connector:{type:'notion',account:'invented',token:{env:'NOTION_TOKEN'},pages:[id]}}}});
  expect(c.enabledSources).toEqual([]);expect(sourceGroups(c)['all-notes']).toEqual(['notes','knowledge']);
});
