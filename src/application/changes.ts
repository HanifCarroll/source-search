import {join} from 'node:path';
import {directKinds,snapshotKinds} from '../domain/change-policy';
import {changesSchema} from '../domain/changes';
import {sourceKind} from '../domain/source-catalog';
import {assertPacket} from '../domain/results';
import {errorData} from '../domain/identity';
import {requireSource,sourceScope,evidenceScope,type Config} from '../platform/config';
import {recordStore} from '../platform/record-store';
import {memoryStore} from '../platform/memory-store';

export function changeTools(config:Config){
  async function list_changes(input:unknown):Promise<unknown>{
    const request=changesSchema.parse(input);
    try{
      if(request.feed==='memory'){
        const page=await memoryStore(config.memoryRoot).changes(request.cursor,request.limit);
        const result={feed:'memory',...page,items:page.items.map(r=>({sequence:r.sequence,id:r.id,revision:r.revision,kind:r.content.kind,status:r.status,observedAt:r.updatedAt})),coverage:'Explicit memory revisions; retained with durable memory'};
        assertPacket(result);return result;
      }
      const sources=[...new Set(request.sources!)].sort(),supported:Record<string,string>={},unsupported:string[]=[];
      for(const source of sources){requireSource(config,source);if(snapshotKinds.includes(sourceKind(source,config)))supported[source]=sourceScope(config,source);else if(directKinds.includes(sourceKind(source,config)))supported[source]=evidenceScope(config,source);else unsupported.push(source);}
      // Include unsupported selections in the cursor identity as well. Their
      // sentinel scope cannot match any committed snapshot.
      const page=await recordStore(join(config.libraryRoot,'records.sqlite')).changes({...supported,...Object.fromEntries(unsupported.map(s=>[s,'unsupported']))},request.cursor,request.limit);
      const result={feed:'sources',...page,coverage:page.coverage.map(c=>unsupported.includes(c.source)?{source:c.source,state:'unsupported',description:'Derived search projection; track its contributing sources instead'}:c),semantics:'Changes observed by synchronization of selected sources; see coverage for granularity and windows. Removed means absent from the selected snapshot, not necessarily deleted upstream. Reset requires establishing a fresh baseline; index-level resets require rerunning relevant searches. Cache cleanup resets this feed.'};
      assertPacket(result);return result;
    }catch(e){if(errorData(e).code==='OUTPUT_LIMIT'&&request.limit>1)return list_changes({...request,limit:Math.max(1,Math.floor(request.limit/2))});throw e;}
  }
  return {list_changes};
}
