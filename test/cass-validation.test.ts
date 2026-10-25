import {test,expect} from 'bun:test';
import {CassProvider} from '../src/vendor/cass/provider';
import type {CassRunner} from '../src/vendor/cass/contracts';

const hit={source_path:'/synthetic/session',line_number:1,agent:'codex',source_id:'local',origin_kind:'local',title:'Fixture',snippet:'Fixture body'};
const result=(data:unknown)=>({stdout:JSON.stringify(data),stderr:'',exitCode:0,timedOut:false,outputLimitExceeded:false});
test('CASS schemas preserve null normalization and reject malformed provenance and limits',async()=>{
  let data:any={hits:[{...hit,title:'',workspace:'',created_at:''}],total_matches:1};
  const runner:CassRunner=async()=>result(data);
  const provider=new CassProvider({runner});
  const page=await provider.search({query:'fixture'});
  expect(page.hits[0]).toMatchObject({title:null,score:null,provenance:{workspace:null,createdAt:''}});
  for(const bad of [{line_number:0},{line_number:Number.MAX_SAFE_INTEGER+1},{source_path:'relative'},{snippet:'x\0y'},{agent:'😀'.repeat(65)}]) {
    data={hits:[{...hit,...bad}]};await expect(provider.search({query:'fixture'})).rejects.toMatchObject({code:'invalid_response'});
  }
  data={hits:[{...hit,origin_kind:'remote'}]};await expect(provider.search({query:'fixture'})).rejects.toMatchObject({code:'remote_source_rejected'});
});
