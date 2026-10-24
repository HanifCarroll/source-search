import {z} from 'zod';
import {fail} from '../../domain/identity';

export function checked<T>(schema:z.ZodType<T>,value:unknown):T{
  const parsed=schema.safeParse(value);if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Provider returned an incomplete or invalid record');return parsed.data;
}
export async function pages<T>(start:string,read:(path:string)=>Promise<{items:T[];next?:string;checkpoint?:string}>){
  const items:T[]=[],seen=new Set<string>();let path=start;
  while(path){
    if(seen.has(path))fail('INVALID_PROVIDER_RESPONSE','Provider repeated a continuation page');seen.add(path);
    if(seen.size>10000)fail('SOURCE_LIMIT','Provider exceeded 10,000 pages');
    const page=await read(path);items.push(...page.items);
    if(items.length>200000)fail('SOURCE_LIMIT','Provider inventory exceeds 200,000 records');
    if(page.next&&page.checkpoint)fail('INVALID_PROVIDER_RESPONSE','Provider returned two continuation states');
    if(!page.next)return {items,checkpoint:page.checkpoint};path=page.next;
  }
  return {items,checkpoint:undefined};
}
export function collectionLink(value:string,origin:string,path:string){
  let url:URL;try{url=new URL(value);}catch{return fail('INVALID_PROVIDER_RESPONSE','Invalid continuation link');}
  if(url.origin!==new URL(origin).origin||url.username||url.password||url.hash||url.pathname!==new URL(origin+path).pathname)fail('INVALID_PROVIDER_RESPONSE','Continuation left its selected collection');
  return path+url.search;
}
export const identity=(parts:string[])=>Buffer.from(JSON.stringify(parts)).toString('base64url');
export function identityParts(id:string,count:number):string[]{try{const v=JSON.parse(Buffer.from(id,'base64url').toString());if(!Array.isArray(v)||v.length!==count||v.some(p=>typeof p!=='string'||!p||p.length>2048))throw Error();return v;}catch{return fail('INVALID_REFERENCE','Invalid provider record reference');}}
