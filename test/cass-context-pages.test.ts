import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,chmod,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from './helpers/config';
import {createRuntime} from '../src/runtime';

test('CASS context continuation retains the neighboring-message window',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cass-context-pages-'));
 try {
  const binary=join(root,'cass'),data=join(root,'data');await mkdir(data);
  await writeFile(binary,`#!${process.execPath}
const args=process.argv.slice(2);
const context=Number(args[args.indexOf('--context')+1]);
const response=args.includes('health')?{healthy:true,initialized:true,status:'healthy',index:{exists:true},database:{opened:true}}:
args.includes('search')?{hits:[{title:'Fixture',snippet:'needle',source_path:'/synthetic/session',line_number:2,agent:'codex',source_id:'local',origin_kind:'local'}],total_matches:1,_meta:{next_cursor:null}}:
{path:'/synthetic/session',target_line:2,context,total_lines:2,source_exists:false,archive_only:true,lines:[...(context?[{line:1,content:'A'.repeat(10000),highlighted:false}]:[]),{line:2,content:'needle original passage',highlighted:true}]};
console.log(JSON.stringify(response));
`);await chmod(binary,0o700);
  const runtime=createRuntime({...defaultConfig(),cassBinary:binary,cassData:data});
  const search=await runtime.search_sources({queries:[{source:'agent-history',query:'needle',limit:1}]});
  const ref=search.results[0].items[0].ref;
  const first=await runtime.read_record({ref,context:true});
  expect(first.record.nextCursor).toBeDefined();
  expect(first.record.body).not.toContain('needle');
  const second=await runtime.read_record({ref,context:true,cursor:first.record.nextCursor});
  expect(first.record.body+second.record.body).toBe('1: '+'A'.repeat(10000)+'\n2: needle original passage');
  expect(second.record.nextCursor).toBeUndefined();
  await expect(runtime.read_record({ref,context:false,cursor:first.record.nextCursor})).rejects.toThrow('Cursor');
 } finally {await rm(root,{recursive:true,force:true});}
});
