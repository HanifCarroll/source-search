import {z} from 'zod';
import {open,rm} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {memoryRevisionSchema} from '../domain/memory';
import {fail,hash,stableJson} from '../domain/identity';
import {memoryStore} from './memory-store';
import {privateDirectory} from './storage';
import {textFile} from './source-files';

const exportSchema=z.object({format:z.literal('source-search-memory'),version:z.literal(1),entries:z.array(memoryRevisionSchema).max(100000),checksum:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function exportMemory(root:string,path:string){
  if(!isAbsolute(path))fail('INVALID_PATH','Use an absolute export path');
  const data=await memoryStore(root).exportData(),body=JSON.stringify({...data,checksum:hash(stableJson(data))});
  await privateDirectory(dirname(path));
  const file=await open(path,'wx',0o600);
  try{await file.writeFile(body);await file.sync();}catch(e){await file.close();await rm(path,{force:true});throw e;}
  await file.close();return {path,revisions:data.entries.length,bytes:Buffer.byteLength(body)};
}
export async function restoreMemory(root:string,path:string){
  if(!isAbsolute(path))fail('INVALID_PATH','Use an absolute backup path');
  const backup=exportSchema.parse(JSON.parse(await textFile(path,64*1024*1024))),{checksum,...data}=backup;
  if(checksum!==hash(stableJson(data)))fail('INVALID_BACKUP','Backup checksum does not match');
  const latest=new Map<string,typeof data.entries[number]>(),operations=new Set<string>();
  for(let i=0;i<data.entries.length;i++){
    const r=data.entries[i]!,old=latest.get(r.id),corrects=r.content.corrects;
    // Revision order is authoritative even if the host clock moved backwards.
    if(r.sequence!==i+1||r.revision!==(old?.revision||0)+1||operations.has(r.operationId)||old&&r.createdAt!==old.createdAt)fail('INVALID_BACKUP','Revision history is inconsistent');
    if(corrects&&(!latest.has(corrects.id)||latest.get(corrects.id)!.revision<corrects.revision))fail('INVALID_BACKUP','Correction target is missing from earlier history');
    if(stableJson(r.content.evidence)!==stableJson(r.evidence.map(({checkedAt,scope,...e})=>e)))fail('INVALID_BACKUP','Evidence does not match the stored content');
    if(Buffer.byteLength(JSON.stringify(r))>24000)fail('INVALID_BACKUP','Revision exceeds the memory size limit');
    operations.add(r.operationId);latest.set(r.id,r);
  }
  return memoryStore(root).restore(data.entries);
}
