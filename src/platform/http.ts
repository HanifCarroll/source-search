import type {Secret} from './source-settings';
import {readSecret} from './credentials';
import {fail} from '../domain/identity';

export type HttpRead=(path:string,body?:Record<string,unknown>)=>Promise<unknown>;
type Options={token?:Secret|(()=>Promise<string>);headers?:Record<string,string>;encoding?:'json'|'form';fetch?:(url:string|URL,init?:RequestInit)=>Promise<Response>;maxRequests?:number;timeoutMs?:number;minIntervalMs?:number};
// Providers choose fixed read endpoints. A returned next link is checked at its
// collection as well as here at the origin; redirects cannot forward tokens.
export function providerHttp(origin:string,options:Options={}){
  const base=new URL(origin),deadline=Date.now()+(options.timeoutMs||600000);let requests=0,lastRequest=0;
  async function request(path:string,body?:Record<string,unknown>,asText=false){
    if(!path.startsWith('/')||path.startsWith('//'))fail('INVALID_PROVIDER_RESPONSE','Expected a provider-relative path');
    const url=new URL(origin.replace(/\/$/,'')+path);
    if(url.origin!==base.origin||url.username||url.password||url.hash)fail('INVALID_PROVIDER_RESPONSE','Invalid provider URL');
    if(++requests>(options.maxRequests||10000)||Date.now()>=deadline)fail('SOURCE_LIMIT','Source sync exceeded its request budget; select fewer collections');
    const token=options.token&&(typeof options.token==='function'?await options.token():await readSecret(options.token));
    const encoding=options.encoding||'json';
    const encoded=body?(encoding==='form'?new URLSearchParams(Object.entries(body).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)])):JSON.stringify(body)):undefined;
    const pause=(options.minIntervalMs||0)-(Date.now()-lastRequest);if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));lastRequest=Date.now();
    let response:Response;
    try{response=await (options.fetch||fetch)(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now()))),
      headers:{Accept:asText?'text/plain':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...options.headers,...(body?{'Content-Type':encoding==='form'?'application/x-www-form-urlencoded':'application/json'}:{})},body:encoded});}
    catch{return fail('PROVIDER_UNAVAILABLE','Provider request failed or timed out');}
    if(!response.ok){
      let code='';if([400,404,409].includes(response.status)){try{code=(JSON.parse(await boundedBody(response,8192)) as any).error?.code||'';}catch{}}else await response.body?.cancel();
      const error=response.status===410||['syncStateNotFound','SyncStateNotFound','InvalidDeltaToken','resyncRequired'].includes(code)?'SYNC_STATE_EXPIRED':response.status===429?'RATE_LIMITED':[401,403].includes(response.status)?'AUTH_REQUIRED':response.status===404?'RECORD_NOT_FOUND':'PROVIDER_ERROR';
      const retry=response.headers.get('retry-after'),wait=retry&&/^\d+$/.test(retry)?` Retry after ${retry} seconds.`:'';
      throw Object.assign(new Error(`Provider returned HTTP ${response.status}.${wait}`),{code:error,httpStatus:response.status});
    }
    const text=await boundedBody(response,32*1024*1024);
    if(asText)return text;
    try{return JSON.parse(text);}catch{return fail('INVALID_PROVIDER_RESPONSE','Provider returned invalid JSON');}
  }
  return {json:((path,body)=>request(path,body)) as HttpRead,text:(path:string)=>request(path,undefined,true) as Promise<string>};
}
export async function boundedBody(response:Response,max:number){
  if(!response.body)fail('INVALID_PROVIDER_RESPONSE','Provider returned no data');
  let text='',bytes=0;const decoder=new TextDecoder();
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>max)fail('SOURCE_LIMIT','Provider response exceeds its size limit');text+=decoder.decode(chunk,{stream:true});}
  return text+decoder.decode();
}
