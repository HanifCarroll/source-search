import {test,expect} from 'bun:test';
import {smartCollectionSync,calendarMultiGet,addressBookMultiGet} from 'tsdav';
import {davProvider,davTransport} from '../src/sources/pim/dav';
import {configSchema} from '../src/platform/config';

const calendar='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:invented\r\nDTSTART:20261024T100000Z\r\nDTEND:20261024T110000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Invented constellation\r\nEND:VEVENT\r\nEND:VCALENDAR';
const card='BEGIN:VCARD\r\nVERSION:3.0\r\nUID:invented\r\nFN:Invented astronomer\r\nEMAIL:star@example.test\r\nEND:VCARD';
const root='https://dav.example.test',url=root+'/books/lab/';
const xml=(body:string)=>new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">'+body+'</d:multistatus>',{status:207,headers:{'Content-Type':'application/xml'}});

for(const type of ['caldav','carddav'] as const)test(`${type} uses real tsdav XML sync, preserves unchanged originals, applies deletions and resets rejected tokens`,async()=>{
  let phase=0,reset=false;const seen:string[]=[];const resource=url+(type==='caldav'?'event.ics':'person.vcf'),data=type==='caldav'?calendar:card;
  const settings={type,serverUrl:root,account:'invented',username:'invented',password:{env:'UNUSED'},allowedOrigins:[],timeZone:'UTC'};
  const transport=davTransport(settings,(async(input:any,init:any)=>{
    expect(String(input)).toBe(url);expect(init.method).toBe('REPORT');seen.push(init.body);const body=String(init.body);
    if(body.includes('sync-collection')){
      if(phase===2&&body.includes('token-one'))return new Response('<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',{status:403});
      if(phase===2)reset=true;
      return xml('<d:sync-token>token-one</d:sync-token><d:response><d:href>'+resource+'</d:href>'+(phase===1?'<d:status>HTTP/1.1 404 Not Found</d:status>':'<d:propstat><d:prop><d:getetag>v1</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>')+'</d:response>');
    }
    const tag=type==='caldav'?'c:calendar-data':'card:address-data';
    return xml('<d:response><d:href>'+resource+'</d:href><d:propstat><d:prop><d:getetag>v1</d:getetag><'+tag+'><![CDATA['+data+']]></'+tag+'></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
  }) as typeof fetch);
  const collection={url,displayName:'Lab',reports:['syncCollection']};
  const client:any={login:async()=>{},fetchCalendars:async()=>[collection],fetchAddressBooks:async()=>[collection],
    smartCollectionSync:(options:any)=>smartCollectionSync({...options,account:{serverUrl:root,homeUrl:root+'/books/',accountType:type},fetch:transport}),calendarMultiGet,addressBookMultiGet,
    fetchCalendarObjects:async()=>[{url:resource,data,etag:'v1'}],fetchVCards:async()=>[{url:resource,data,etag:'v1'}]};
  const provider=davProvider('dav',settings,{pastDays:36500,futureDays:36500},async()=>client);
  const first=await provider.sync();expect(first.records).toHaveLength(type==='caldav'?2:1);expect((await provider.read(first.records[0]!.ref.id)).ref.version).toBe(first.records[0]!.ref.version);
  phase=1;expect((await provider.sync(first.checkpoint)).records).toHaveLength(0);
  phase=2;expect((await provider.sync(first.checkpoint)).records).toHaveLength(type==='caldav'?2:1);expect(reset).toBe(true);
  expect(seen.some(v=>v.includes(type==='caldav'?'calendar-multiget':'addressbook-multiget'))).toBe(true);
});

test('DAV ctag fallback skips unchanged collections and selection applies before object reads',async()=>{
  let fetches=0;
  const settings={type:'carddav' as const,serverUrl:root,account:'invented',username:'invented',password:{env:'UNUSED'},allowedOrigins:[],timeZone:'UTC',collections:[url]};
  const transport=davTransport(settings,(async()=>xml('<d:response><d:href>'+url+'</d:href><d:propstat><d:prop><cs:getctag xmlns:cs="http://calendarserver.org/ns/">one</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')) as unknown as typeof fetch);
  const client:any={fetchAddressBooks:async()=>[{url,displayName:'Lab'},{url:root+'/books/excluded/'}],smartCollectionSync:(options:any)=>smartCollectionSync({...options,account:{serverUrl:root,homeUrl:root+'/books/',accountType:'carddav'},fetch:transport}),addressBookMultiGet,
    fetchVCards:async({addressBook}:any)=>{expect(addressBook.url).toBe(url);fetches++;return [{url:url+'person.vcf',data:card}];}};
  const p=davProvider('dav',settings,{pastDays:1,futureDays:1},async()=>client),first=await p.sync();expect(first.records).toHaveLength(1);
  expect((await p.sync(first.checkpoint)).records).toHaveLength(1);expect(fetches).toBe(1);
});

test('DAV transport disallows writes and credential forwarding; configuration accepts another provider without enabling it',async()=>{
  const f=davTransport({serverUrl:root,allowedOrigins:[]});
  await expect(f(root+'/books/',{method:'PUT'})).rejects.toMatchObject({code:'READ_ONLY'});
  await expect(f('https://unselected.example.test/books/',{method:'PROPFIND'})).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
  const c=configSchema.parse({sources:{nextcloud:{adapter:'address-books',connector:{type:'carddav',account:'test',serverUrl:'https://cloud.example.test/remote.php/dav',username:'invented',password:{env:'NEXTCLOUD_PASSWORD'}}}}});
  expect(c.enabledSources).toEqual([]);
});

test('DAV transport retains the response URL for discovery and enforces the configured request limit',async()=>{
  const f=davTransport({serverUrl:root,allowedOrigins:[]},(async()=>new Response('DAV response',{status:200})) as unknown as typeof fetch,{timeoutMs:30000,maxRequests:1});
  const response=await f(root+'/books/',{method:'PROPFIND'});
  expect(response.url).toBe(root+'/books/');expect(await response.text()).toBe('DAV response');
  await expect(f(root+'/books/',{method:'PROPFIND'})).rejects.toMatchObject({code:'SOURCE_LIMIT'});
});
