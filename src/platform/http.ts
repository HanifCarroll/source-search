import pRetry from 'p-retry';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {Secret} from './source-settings';
import {readSecret} from './credentials';
import {fail} from '../domain/identity';

export type HttpResponseRead = (path:string, body?:Record<string,unknown>) => Promise<{data:unknown;headers:Headers}>;
export type HttpRead = (path:string, body?:Record<string,unknown>) => Promise<unknown>;
type Options = {
  token?:Secret|(()=>Promise<string>);
  headers?:Record<string,string>;
  encoding?:'json'|'form';
  fetch?:(url:string|URL,init?:RequestInit)=>Promise<Response>;
  maxRequests?:number;
  timeoutMs?:number;
  minIntervalMs?:number;
  tokenScheme?:'bearer'|'raw';
  signal?:AbortSignal;
  retry?:{retries?:number;minTimeout?:number;maxTimeout?:number};
};
type ProviderError = Error & {code?:string;httpStatus?:number;retryAfterMs?:number};
const errorResponse = z.object({error:z.object({code:z.string().optional()}).optional()});
const retryable = (error:ProviderError) => error.code === 'PROVIDER_UNAVAILABLE' ||
  error.code === 'RATE_LIMITED' || [408,500,502,503,504].includes(error.httpStatus || 0);
function retryAfter(value:string|null):number|undefined {
  if(!value)return;
  const ms=/^\d+$/.test(value) ? Number(value)*1000 : Date.parse(value)-Date.now();
  return Number.isFinite(ms) ? Math.max(0,ms) : undefined;
}

// This interface is for provider reads, including query-only POST endpoints.
// Attempts share the caller's request budget and one bounded request deadline.
export function providerHttp(origin:string, options:Options = {}) {
  const base = new URL(origin);
  const deadline = Date.now() + (options.timeoutMs ?? 600000);
  let requests = 0, lastRequest = 0;

  async function request(path:string, body?:Record<string,unknown>, asText=false, withHeaders=false) {
    if(!path.startsWith('/') || path.startsWith('//'))fail('INVALID_PROVIDER_RESPONSE','Expected a provider-relative path');
    const url = new URL(origin.replace(/\/$/,'') + path);
    if(url.origin!==base.origin || url.username || url.password || url.hash)fail('INVALID_PROVIDER_RESPONSE','Invalid provider URL');
    if(Date.now()>=deadline)fail('SOURCE_LIMIT','Source sync exceeded its request budget; select fewer collections');
    const token = options.token && (typeof options.token==='function' ? await options.token() : await readSecret(options.token));
    const encoding = options.encoding || 'json';
    const encoded = body ? (encoding==='form'
      ? new URLSearchParams(Object.entries(body).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)]))
      : JSON.stringify(body)) : undefined;
    const requestDeadline = Math.min(deadline,Date.now()+30000);
    const timeout = AbortSignal.timeout(Math.max(1,requestDeadline-Date.now()));
    const signal = options.signal ? AbortSignal.any([timeout,options.signal]) : timeout;
    let lastError:ProviderError|undefined;
    try {
      return await pRetry(async () => {
        signal.throwIfAborted();
        if(++requests>(options.maxRequests ?? 10000) || Date.now()>=deadline)
          fail('SOURCE_LIMIT','Source sync exceeded its request budget; select fewer collections');
        const pause = (options.minIntervalMs || 0) - (Date.now()-lastRequest);
        if(pause>0)await delay(pause,undefined,{signal});
        lastRequest=Date.now();
        let response:Response;
        try {
          response=await (options.fetch || fetch)(url,{
            method:body?'POST':'GET',redirect:'error',signal,
            headers:{Accept:asText?'text/plain':'application/json',
              ...(token?{Authorization:(options.tokenScheme==='raw'?'':'Bearer ')+token}:{}),...options.headers,
              ...(body?{'Content-Type':encoding==='form'?'application/x-www-form-urlencoded':'application/json'}:{})},body:encoded,
          });
        } catch {return fail('PROVIDER_UNAVAILABLE','Provider request failed or timed out');}
        if(!response.ok) {
          let providerCode='';
          if([400,404,409].includes(response.status)) {
            try {const parsed=errorResponse.safeParse(JSON.parse(await boundedBody(response,8192)));if(parsed.success)providerCode=parsed.data.error?.code || '';}
            catch {/* Provider error bodies are optional; HTTP status remains authoritative. */}
          } else await response.body?.cancel();
          const code = response.status===410 || ['syncStateNotFound','SyncStateNotFound','InvalidDeltaToken','resyncRequired'].includes(providerCode)
            ? 'SYNC_STATE_EXPIRED' : response.status===429 || response.status===403 && response.headers.get('x-ratelimit-remaining')==='0'
            ? 'RATE_LIMITED' : [401,403].includes(response.status) ? 'AUTH_REQUIRED' : response.status===404 ? 'RECORD_NOT_FOUND' : 'PROVIDER_ERROR';
          const retryAfterMs = retryAfter(response.headers.get('retry-after'));
          throw Object.assign(new Error(`Provider returned HTTP ${response.status}.${retryAfterMs===undefined?'':` Retry after ${Math.ceil(retryAfterMs/1000)} seconds.`}`),
            {code,httpStatus:response.status,retryAfterMs});
        }
        let text:string;
        try{text=await boundedBody(response,32*1024*1024);}
        catch(error){
          // A connection can fail after headers arrive. Retry the whole read,
          // while preserving size-limit and malformed-response errors.
          if(['SOURCE_LIMIT','INVALID_PROVIDER_RESPONSE'].includes((error as ProviderError).code||''))throw error;
          return fail('PROVIDER_UNAVAILABLE','Provider response was interrupted');
        }
        if(asText)return text;
        try {const data:unknown=JSON.parse(text);return withHeaders?{data,headers:response.headers}:data;}
        catch {return fail('INVALID_PROVIDER_RESPONSE','Provider returned invalid JSON');}
      }, {
        retries:options.retry?.retries ?? 2,
        minTimeout:options.retry?.minTimeout ?? 250,
        maxTimeout:options.retry?.maxTimeout ?? 1000,
        randomize:true,
        maxRetryTime:Math.max(1,requestDeadline-Date.now()),signal,
        onFailedAttempt:({error})=>{lastError=error as ProviderError;},
        shouldRetry:async ({error,retryDelay}) => {
          const failure=error as ProviderError;
          if(!retryable(failure) || requests >= (options.maxRequests ?? 10000))return false;
          const wait=Math.max(failure.retryAfterMs || 0,retryDelay);
          if(Date.now()+wait>=requestDeadline)return false;
          // p-retry supplies backoff; add only the extra provider-requested wait.
          if(wait>retryDelay)await delay(wait-retryDelay,undefined,{signal});
          return true;
        },
      });
    } catch(error) {
      if(signal.aborted)throw lastError || Object.assign(new Error('Provider request failed or timed out'),{code:'PROVIDER_UNAVAILABLE'});
      throw error;
    }
  }
  return {
    page:((path,body)=>request(path,body,false,true)) as HttpResponseRead,
    json:((path,body)=>request(path,body)) as HttpRead,
    text:(path:string)=>request(path,undefined,true) as Promise<string>,
  };
}
export async function boundedBody(response:Response,max:number) {
  if(!response.body)fail('INVALID_PROVIDER_RESPONSE','Provider returned no data');
  let text='',bytes=0;
  const decoder=new TextDecoder();
  for await(const chunk of response.body) {
    bytes+=chunk.length;
    if(bytes>max)fail('SOURCE_LIMIT','Provider response exceeds its size limit');
    text+=decoder.decode(chunk,{stream:true});
  }
  return text+decoder.decode();
}
