import {DAVClient,type DAVCollection,type DAVObject} from 'tsdav';
import {z} from 'zod';
import {readSecret} from '../../platform/credentials';
import {boundedBody} from '../../platform/http';
import type {DavSettings} from '../../platform/connected-settings';
import {parsePimText} from '../../formats/pim';
import {fail,versioned} from '../../domain/identity';
import {checked,identity,identityParts} from '../sync/paging';
import {calendarWindow} from './model';
import type {SourceProvider} from '../sync/model';

// tsdav owns discovery, XML, sync tokens and ctag fallback. The transport bounds
// reads and only forwards credentials to explicitly configured DAV origins.
export function davTransport(settings:Pick<DavSettings,'serverUrl'|'allowedOrigins'>,fetcher:typeof fetch=fetch):typeof fetch{
  const origins=new Set([new URL(settings.serverUrl).origin,...settings.allowedOrigins]),deadline=Date.now()+600000;let count=0;
  return (async(input:RequestInfo|URL,init:RequestInit={})=>{
    const url=new URL(input instanceof Request?input.url:String(input)),method=(init.method||'GET').toUpperCase();
    if(!origins.has(url.origin)||url.username||url.password||url.hash)fail('INVALID_PROVIDER_RESPONSE','DAV discovery requires an origin listed in allowedOrigins');
    if(!['GET','HEAD','OPTIONS','PROPFIND','REPORT'].includes(method))fail('READ_ONLY','DAV connector only supports reads');
    if(++count>10000||Date.now()>deadline)fail('SOURCE_LIMIT','DAV sync exceeded its request budget');
    let response:Response;
    try{response=await fetcher(url,{...init,method,redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now())))});}catch{return fail('PROVIDER_UNAVAILABLE','DAV request failed or timed out');}
    if(response.status===401||response.status===429){await response.body?.cancel();fail(response.status===401?'AUTH_REQUIRED':'RATE_LIMITED','DAV returned HTTP '+response.status+'; check the credential or retry later');}
    const text=response.body?await boundedBody(response,32*1024*1024):null;
    return new Response(text,{status:response.status,statusText:response.statusText,headers:response.headers});
  }) as typeof fetch;
}

type Client=Pick<DAVClient,'login'|'fetchCalendars'|'fetchAddressBooks'|'smartCollectionSync'|'fetchCalendarObjects'|'fetchVCards'|'calendarMultiGet'|'addressBookMultiGet'>;
const object=z.object({url:z.string(),etag:z.string().optional(),data:z.string()});
const state=z.object({version:z.literal(1),collections:z.array(z.object({url:z.string(),ctag:z.string().optional(),syncToken:z.string().optional(),objects:z.array(object)}))});
function within(url:string,collection:string){const u=new URL(url),c=new URL(collection);if(u.origin!==c.origin||!u.pathname.startsWith(c.pathname.replace(/\/$/,'')+'/')||u.username||u.password||u.hash)fail('INVALID_PROVIDER_RESPONSE','DAV object left its selected collection');return u.href;}
export function davProvider(source:string,settings:DavSettings,windowOptions:{pastDays:number;futureDays:number},create?:()=>Promise<Client>):SourceProvider{
  let connection:Promise<Client>|undefined;
  const client=()=>connection??=(create?create():(async()=>{const c=new DAVClient({serverUrl:settings.serverUrl,credentials:{username:settings.username,password:await readSecret(settings.password)},authMethod:'Basic',defaultAccountType:settings.type,fetch:davTransport(settings)});await c.login({loadCollections:false});return c;})());
  async function inventory(){const c=await client();const collections=settings.type==='caldav'?await c.fetchCalendars():await c.fetchAddressBooks();
    if(new Set(collections.map(v=>v.url)).size!==collections.length)fail('INVALID_PROVIDER_RESPONSE','DAV repeated a collection');
    if(settings.collections?.some(id=>!collections.some(v=>v.url===id)))fail('SOURCE_UNAVAILABLE','A selected DAV collection is missing or inaccessible');
    return collections.filter(v=>!settings.collections||settings.collections.includes(v.url));
  }
  function records(collection:DAVCollection,objects:DAVObject[],range?:{from:string;to:string}){
    const output=[],warnings=[];
    for(const value of objects){const item=checked(object,value);within(item.url,collection.url);if(Buffer.byteLength(item.data)>8*1024*1024)fail('SOURCE_LIMIT','DAV object exceeds 8 MiB');
      const parsed=parsePimText(item.data,{source,path:item.url,format:settings.type==='caldav'?'ical':'vcard',timeZone:settings.timeZone,range});warnings.push(...parsed.warnings);
      for(const r of parsed.records)output.push(versioned({...r,adapter:settings.type==='caldav'?'calendars':'address-books',ref:{source,id:identity([collection.url,item.url,r.ref.id])},body:`${settings.type==='caldav'?'Calendar':'Address book'}: ${String(collection.displayName||collection.url)}\n\n${r.body}`,metadata:{...r.metadata,provider:settings.type}}));
    }return {records:output,warnings};
  }
  return {async lists(){return (await inventory()).map(v=>({id:v.url,name:String(v.displayName||v.url)}));},async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined,c=await client(),window=settings.type==='caldav'?calendarWindow(windowOptions):undefined;
    const collections=[],output=[],warnings=[];
    for(const collection of await inventory()){
      const prior=old?.collections.find(v=>v.url===collection.url);
      const selected:DAVCollection={...collection,objects:prior?.objects||[],ctag:prior?.ctag,syncToken:prior?.syncToken,
        objectMultiGet:settings.type==='caldav'?c.calendarMultiGet.bind(c):c.addressBookMultiGet.bind(c),
        fetchObjects:async()=>settings.type==='caldav'?c.fetchCalendarObjects({calendar:collection}):c.fetchVCards({addressBook:collection})};
      let result:DAVCollection;try{result=await c.smartCollectionSync({collection:selected});}catch(e){if((e as any).code)throw e;fail('PROVIDER_ERROR','DAV synchronization failed; previous snapshot retained');}
      const objects=checked(z.array(object),result.objects);
      const mapped=records(collection,objects,window);output.push(...mapped.records);warnings.push(...mapped.warnings);
      collections.push({url:collection.url,ctag:result.ctag,syncToken:result.syncToken,objects});
    }
    return {records:output,checkpoint:{version:1,collections},coverageWindow:window,strategy:'dav-sync-or-ctag',coverage:window?`Selected CalDAV occurrences from ${window.from} to ${window.to}; complete calendar objects retained for recurrence expansion`:'Selected CardDAV address books',warnings:[...new Set(warnings)]};
  },async read(ref){
    const [collectionUrl,url,recordId]=identityParts(ref,3),collection=(await inventory()).find(v=>v.url===collectionUrl);if(!collection)fail('RECORD_NOT_FOUND','DAV collection is no longer selected');within(url!,collectionUrl!);
    const c=await client(),objects=settings.type==='caldav'?await c.fetchCalendarObjects({calendar:collection,objectUrls:[url!]}):await c.fetchVCards({addressBook:collection,objectUrls:[url!]});
    let range;if(settings.type==='caldav'){let at:number;try{at=Date.parse(JSON.parse(Buffer.from(recordId!,'base64url').toString()).at);}catch{at=NaN;}if(!Number.isFinite(at))fail('INVALID_REFERENCE','DAV event reference has no occurrence date');range={from:new Date(at).toISOString(),to:new Date(at+1000).toISOString()};}
    const r=records(collection,objects,range).records.find(r=>r.ref.id===ref);if(!r)fail('RECORD_NOT_FOUND','DAV record was removed or changed occurrence');return r;
  }};
}
