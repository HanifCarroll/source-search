import {z} from 'zod';
import {fail} from '../../domain/identity';
import type {HttpRead} from '../../platform/http';
import {checked,pages,collectionLink} from './paging';
export const graphOrigin='https://graph.microsoft.com/v1.0';
export const graphHeaders={Prefer:'IdType="ImmutableId", outlook.timezone="UTC"'};
export async function graphPages(http:HttpRead,collection:string,start=collection,delta=false){
  const result=await pages(start,async path=>{
    const page=checked(z.object({value:z.array(z.record(z.string(),z.any())),'@odata.nextLink':z.string().optional(),'@odata.deltaLink':z.string().optional()}),await http(path));
    return {items:page.value,next:page['@odata.nextLink']?collectionLink(page['@odata.nextLink'],graphOrigin,collection):undefined,checkpoint:page['@odata.deltaLink']?collectionLink(page['@odata.deltaLink'],graphOrigin,collection):undefined};
  });
  if(delta&&!result.checkpoint)fail('INCOMPLETE_SOURCE','Microsoft delta scan ended without a checkpoint');
  if(!delta&&result.checkpoint)fail('INVALID_PROVIDER_RESPONSE','Unexpected Microsoft delta state');
  return result;
}
