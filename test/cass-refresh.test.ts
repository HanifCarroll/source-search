import {test,expect} from 'bun:test';
import {defaultConfig} from './helpers/config';
import {cassStatus,searchCass,readCass} from '../src/sources/agent-history/index';
import { querySchema } from "../src/domain/contracts";
import type {CassRunnerRequest} from '../src/vendor/cass/contracts';

test('completed lexical assets remain readable during refresh without maintenance',async()=>{
 const calls:CassRunnerRequest[]=[];let snippet='fixture';
 const health:any={healthy:false,initialized:true,status:'rebuilding',errors:['index stale','index rebuild in progress'],rebuild:{active:true},index:{exists:true,documents:10,engine_incompatible:false,checkpoint:{completed:true}},database:{exists:true,opened:true}};
 const runner=async(r:CassRunnerRequest)=>{calls.push(r);const data=r.args.includes('health')?health:r.args.includes('search')?{hits:[{title:'Fixture',snippet,source_path:'/synthetic/session',line_number:1,agent:'codex',source_id:'fixture-import',origin_kind:'local'}],total_matches:1,_meta:{next_cursor:null}}:{path:'/synthetic/session',target_line:1,context:5,total_lines:1,source_exists:true,archive_only:false,lines:[{line:1,content:'Fixture context',highlighted:true}]};return {exitCode:r.args.includes('health')?1:0,stdout:JSON.stringify(data),stderr:'',timedOut:false,outputLimitExceeded:false};};
 const c=defaultConfig(),q=querySchema.parse({source:'agent-history',query:'fixture'});
 expect((await cassStatus(c,runner)).available).toBe(true);
 const page=await searchCass(c,q,runner);
 expect(page.warnings.some(w=>w.includes('refresh'))).toBe(true);
 expect((await readCass(c,page.items[0].ref,true,runner)).body).toContain('Fixture context');
 snippet='changed during refresh';await expect(readCass(c,page.items[0].ref,true,runner)).rejects.toThrow('result changed');snippet='fixture';
 expect(calls.filter(r=>r.args.includes('search')).every(r=>r.args.includes('--no-maintenance')&&r.args.includes('--no-daemon'))).toBe(true);
 expect(calls.every(r=>!r.args.includes('index')&&!r.args.includes('models'))).toBe(true);
 for(const mutate of [()=>health.database.opened=false,()=>health.database.exists=false,()=>health.index.exists=false,()=>health.index.engine_incompatible=true,()=>health.index.documents=0,()=>health.index.hollow=true,()=>health.index.partial=true,()=>health.index.checkpoint.completed=false,()=>delete health.index.checkpoint,()=>health.errors.push('database corrupt')]){
  const saved=JSON.stringify(health);mutate();expect((await cassStatus(c,runner)).available).toBe(false);await expect(searchCass(c,q,runner)).rejects.toThrow();Object.assign(health,JSON.parse(saved));
 }
 Object.assign(health,{status:'stalled',errors:['index stale','index rebuild stalled — indexing thread is not making forward progress (issue #258)'],rebuild:{active:true,stalled:true}});
 const stalled=await cassStatus(c,runner);
 expect(stalled.available).toBe(true);expect(stalled.warnings.some(w=>w.includes('no progress'))).toBe(true);
 expect((await searchCass(c,q,runner)).items.length).toBe(1);
 health.errors.push('database corrupt');expect((await cassStatus(c,runner)).available).toBe(false);
 health.errors.pop();health.index.checkpoint.completed=false;expect((await cassStatus(c,runner)).available).toBe(false);
});
