import {lstat} from 'node:fs/promises';
import type {RecordData} from '../../domain/contracts';
import type {Observation,ObservationState} from '../../domain/observations';
import {hash,now,stableJson,fail} from '../../domain/identity';
import type {Config} from '../../platform/config';
export type Previous={state:ObservationState;entries:Observation[]}|undefined;
export type Scan={entries?:Observation[];state:ObservationState};
export type Reader=(c:Config,source:string,previous:Previous)=>Promise<Scan>;
export const observed=(record:RecordData,source=record.ref.source):Observation=>({ref:{...record.ref,source},signature:record.ref.version!});
export const state=(strategy:string,coverage:string):ObservationState=>({strategy,coverage,checkedAt:now(),granularity:'records'});
export async function stamp(paths:string[]){
 const stats=[];for(const path of paths){try{const s=await lstat(path);stats.push([path,s.size,s.mtimeMs,s.ctimeMs,s.ino]);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;stats.push([path,null]);}}
 return hash(stableJson(stats));
}
export async function stamped(paths:string[],previous:Previous,details:ObservationState,read:()=>Promise<Observation[]>,consistentSnapshot=false):Promise<Scan>{
 const signature=await stamp(paths),current={...details,signature};
 if(previous?.state.initialized&&previous.state.signature===signature&&previous.state.generation===current.generation)return {state:current};
 const entries=await read();
 if(signature!==await stamp(paths)){if(consistentSnapshot)return {entries,state:details};fail('SOURCE_CHANGED','Source changed during inventory; retaining the previous inventory for retry');}
 return {entries,state:current};
}

// iCloud hydration can change file metadata during the first read. Retry a
// bounded number of times and retain only a version read under a stable stamp.
export async function stableRead<T>(path:string,read:()=>Promise<T>){
 for(let attempt=0;attempt<3;attempt++){
  const input=await stamp([path]),value=await read();
  if(input===await stamp([path]))return {input,value};
 }
 return fail('SOURCE_CHANGED','File kept changing during read; retry synchronization');
}
