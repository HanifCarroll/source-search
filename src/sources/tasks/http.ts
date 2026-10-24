import {readSecret} from '../../platform/credentials';
import type {Secret} from '../../platform/source-settings';
import {fail} from '../../domain/identity';

export type TaskHttp=(path:string,body?:Record<string,unknown>)=>Promise<unknown>;
// A fixed provider origin and fixed read endpoints keep tokens out of URLs,
// redirects, diagnostics and arbitrary URLs supplied in provider responses.
export function taskHttp(origin:string,token:Secret|(()=>Promise<string>),encoding:'json'|'form'='json'):TaskHttp{
  const deadline=Date.now()+120000;
  return async(path,body)=>{
    const remaining=deadline-Date.now();if(remaining<=0)fail('SOURCE_LIMIT','Task sync exceeded two minutes; retry or select fewer projects');
    const encoded=body?(encoding==='form'?new URLSearchParams(Object.entries(body).map(([key,value])=>[key,typeof value==='string'?value:JSON.stringify(value)])):JSON.stringify(body)):undefined;
    const response=await fetch(origin+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(Math.min(30000,remaining)),
      headers:{Authorization:'Bearer '+await (typeof token==='function'?token():readSecret(token)),...(body?{'Content-Type':encoding==='form'?'application/x-www-form-urlencoded':'application/json'}:{})},body:encoded});
    if(!response.ok){
      // Read only the error code, never expose provider messages or token URLs.
      let providerCode='';
      if([400,404].includes(response.status)&&response.body){let raw='';for await(const chunk of response.body){raw+=Buffer.from(chunk).toString();if(raw.length>8192)break;}try{providerCode=JSON.parse(raw).error?.code||'';}catch{}}
      else await response.body?.cancel();
      const code=response.status===410||['syncStateNotFound','SyncStateNotFound','InvalidDeltaToken','resyncRequired'].includes(providerCode)?'SYNC_STATE_EXPIRED':response.status===429?'RATE_LIMITED':response.status===401||response.status===403?'AUTH_REQUIRED':response.status===404?'RECORD_NOT_FOUND':'PROVIDER_ERROR';
      throw Object.assign(new Error(`Task provider returned HTTP ${response.status}`),{code,httpStatus:response.status});
    }
    if(!response.body)fail('INVALID_PROVIDER_RESPONSE','Task provider returned no data');
    let text='';const decoder=new TextDecoder();let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)fail('SOURCE_LIMIT','Task response exceeds 32 MiB');text+=decoder.decode(chunk,{stream:true});}
    try{return JSON.parse(text+decoder.decode());}catch{return fail('INVALID_PROVIDER_RESPONSE','Task provider returned invalid JSON');}
  };
}
