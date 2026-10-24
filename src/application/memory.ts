import type {Ref,RecordData} from '../domain/contracts';
import {listMemoriesSchema,readMemorySchema,writeMemorySchema,type MemoryRevision} from '../domain/memory';
import {assertVersion,errorData,fail,hash,now,stableJson} from '../domain/identity';
import {assertPacket} from '../domain/results';
import {sourceEnabled,evidenceScope,type Config} from '../platform/config';
import {sourceKind} from '../domain/source-catalog';
import {memoryStore} from '../platform/memory-store';
import {boundedMap} from './concurrency';

export function memoryTools(config:Config,read:(ref:Ref)=>Promise<{record:RecordData}>){
  const store=memoryStore(config.memoryRoot);
  const visible=(r:MemoryRevision)=>{
    const {requestHash,content,evidence,...metadata}=r;
    return {...metadata,...content,evidence:evidence.map(({scope,...e})=>sourceEnabled(config,e.ref.source)&&evidenceScope(config,e.ref.source)===scope
      ?{...e,access:'enabled' as const}:{source:e.ref.source,access:'unavailable' as const,checkedAt:e.checkedAt}),
      knowledge:content.verification?'verified-outcome-attestation' as const:'statement' as const,
      ...(r.revision>1?{previousRevision:{id:r.id,revision:r.revision-1}}:{})};
  };
  async function write_memory(input:unknown){
    const request=writeMemorySchema.parse(input),requestHash=hash(stableJson(request));
    const replay=await store.replay(request.operationId,requestHash);
    if(replay)return {memory:visible(replay),replayed:true};
    if(request.memory){
      for(const entity of request.memory.entities)if(!config.contextEntities[entity])fail('UNKNOWN_ENTITY','Configure the people/project mapping before attaching it to a memory');
    }
    const evidence=await boundedMap(request.memory?.evidence||[],async item=>{
      // Access and pinned versions are checked before the durable transaction.
      if(!sourceEnabled(config,item.ref.source))fail('SOURCE_DISABLED','Enable the evidence source before saving this memory');
      if(['library','documents'].includes(sourceKind(item.ref.source,config)))fail('ORIGINAL_REQUIRED','Read the discovery result and cite its original source reference');
      const {record}=await read(item.ref);
      assertVersion(item.ref,record.ref.version||'');
      if(item.quote&&!record.body.includes(item.quote)&&!record.title.includes(item.quote))fail('EVIDENCE_MISMATCH','The quoted evidence is not present in the referenced record');
      return {...item,checkedAt:now(),scope:evidenceScope(config,item.ref.source)};
    });
    const result={memory:visible(await store.write(request,evidence)),replayed:false};assertPacket(result);return result;
  }
  async function read_memory(input:unknown){
    const request=readMemorySchema.parse(input),saved=await store.read(request.id,request.revision);
    if(!saved)fail('MISSING_MEMORY','Memory revision does not exist');
    const evidenceChecks=request.checkEvidence?await boundedMap(saved.evidence,async (e)=>{
      try{
        if(!sourceEnabled(config,e.ref.source)||evidenceScope(config,e.ref.source)!==e.scope)fail('SOURCE_DISABLED','Evidence source is disabled or its selection changed');
        const {record}=await read(e.ref);assertVersion(e.ref,record.ref.version||'');
        if(e.quote&&!record.body.includes(e.quote)&&!record.title.includes(e.quote))fail('EVIDENCE_MISMATCH','Evidence quote changed');
        return {source:e.ref.source,status:'current' as const,checkedAt:now()};
      }catch(error){return {source:e.ref.source,status:'unavailable' as const,checkedAt:now(),error:errorData(error)};}
    }):undefined;
    const result={memory:visible(saved),evidenceChecks};assertPacket(result);return result;
  }
  async function list_memories(input:unknown):Promise<{items:{id:string;revision:number;kind:string;status:string;text:string;truncated:boolean;entities:string[];updatedAt:string;knowledge:string}[];nextCursor?:string}>{
    const request=listMemoriesSchema.parse(input),result=await store.list(request);
    const output={...result,items:result.items.map(r=>({id:r.id,revision:r.revision,kind:r.content.kind,status:r.status,text:r.content.text.slice(0,300),truncated:r.content.text.length>300,entities:r.content.entities,updatedAt:r.updatedAt,knowledge:r.content.verification?'verified-outcome-attestation':'statement'}))};
    try{assertPacket(output);return output;}catch(e){if(errorData(e).code==='OUTPUT_LIMIT'&&request.limit>1)return list_memories({...request,limit:Math.max(1,Math.floor(request.limit/2))});throw e;}
  }
  return {write_memory,read_memory,list_memories};
}
