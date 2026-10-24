import {test,expect} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {googleCalendarProvider,googleContactsProvider} from '../src/sources/pim/google';
import {microsoftCalendarProvider,microsoftContactsProvider} from '../src/sources/pim/microsoft';
import {calendarWindow,timestamp} from '../src/sources/pim/model';
import {graphPages} from '../src/sources/sync/graph';
import {configSchema,sourceScope} from '../src/platform/config';
import {syncSources} from '../src/maintenance/sources';
import {createRuntime} from '../src/application/runtime';
import {sourceAuthorization} from '../src/platform/source-auth';
import {snapshotStore,scopedProvider} from '../src/sources/sync/cache';
import {privateDirectory,privateJSON} from '../src/platform/storage';

const windowOptions={pastDays:36500,futureDays:36500};
const event={id:'event',summary:'Invented telescope',start:{date:'2026-10-24'},end:{date:'2026-10-25'}};
const expired=()=>Object.assign(new Error('Expired'),{code:'SYNC_STATE_EXPIRED'});

test('an alternate Google calendar and Outlook address book migrate, query through MCP and retain incremental originals',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-pim-foundation-'));let client:import('@modelcontextprotocol/sdk/client/index.js').Client|undefined;
  try{
    const token={env:'UNUSED_FIXTURE_TOKEN'},c=configSchema.parse({maintenanceEnabled:true,enabledSources:['agenda','people'],libraryRoot:join(root,'cache'),sources:{
      agenda:{adapter:'calendars',window:windowOptions,connector:{type:'google',account:'invented-calendar',token}},
      people:{adapter:'address-books',connector:{type:'microsoft',account:'invented-contacts',token}},
    }});
    let phase=0;
    const calendar=googleCalendarProvider('agenda',undefined,windowOptions,async path=>{
      if(phase===2)throw expired();
      if(path.startsWith('/users/'))return {items:[{id:'cal',summary:'Research',timeZone:'America/New_York'}]};
      const current={...event,summary:phase?'Changed telescope':event.summary};
      return path.endsWith('/events/event')?current:{items:[current],nextSyncToken:String(phase)};
    });
    const firstPerson={id:'a',displayName:'Invented Astronomer',emailAddresses:[{address:'astronomer@example.test'}]};
    const contacts=microsoftContactsProvider('people',undefined,async path=>{
      if(phase===2)throw expired();
      if(path==='/me/contactFolders')return {value:[]};
      if(path.startsWith('/me/contacts?$top='))return {value:[{parentFolderId:'native-default'}]};
      if(path.endsWith('/contacts/a'))return firstPerson;
      return {value:phase?[{id:'b','@removed':{reason:'deleted'}}]:[firstPerson,{id:'b',displayName:'Invented Optician'}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/contactFolders/native-default/contacts/delta?$deltatoken='+phase};
    });
    const providers={agenda:scopedProvider(calendar,sourceScope(c,'agenda')),people:scopedProvider(contacts,sourceScope(c,'people'))},factory=(_c:unknown,source:string)=>providers[source as keyof typeof providers];
    const refs=[];
    for(const source of c.enabledSources){
      const store=snapshotStore(c,source),snapshot=await factory(c,source).sync();refs.push(snapshot.records[0]!.ref);
      await privateDirectory(dirname(store.legacyPath));await privateJSON(store.legacyPath,{...snapshot,version:1,scope:sourceScope(c,source),checkedAt:'2026-10-01T00:00:00Z'});
    }
    expect((await syncSources(c,undefined,factory)).ok).toBe(true);
    for(const ref of refs)expect((await snapshotStore(c,ref.source).original(ref,factory(c,ref.source))).ref).toEqual(ref);
    const path=join(root,'config.json');await writeFile(path,JSON.stringify(c));
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    client=new Client({name:'connected-foundation-fixture',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:path},stderr:'pipe'}));
    const search=async(query:object)=>JSON.parse(((await client!.callTool({name:'search_sources',arguments:{queries:[query]}})).content as any[])[0].text).results[0];
    const agenda=await search({source:'all-calendars',query:'',from:'2026-10-24T18:00:00Z',to:'2026-10-25T01:00:00Z'});
    expect(agenda.totalMatches).toBe(1);expect(agenda.coverage.window).toBeDefined();expect(agenda.items[0].ref).toEqual(refs[0]);
    const people=await search({source:'all-contacts',query:'',limit:1});expect(people.totalMatches).toBe(2);expect(people.query.sort).toBe('relevance');
    expect((await search({source:'people',query:'',from:'2026-10-24T00:00:00Z'})).error.code).toBe('UNSUPPORTED_FILTER');
    await syncSources(c,undefined,factory);
    expect((await search({source:'people',query:'',limit:1,cursor:people.nextCursor})).items).toHaveLength(1);
    phase=1;await syncSources(c,undefined,factory);
    expect((await search({source:'people',query:''})).totalMatches).toBe(1);
    expect((await search({source:'people',query:'',limit:1,cursor:people.nextCursor})).error.code).toBe('INVALID_CURSOR');
    await expect(snapshotStore(c,'agenda').original(refs[0]!,providers.agenda)).rejects.toMatchObject({code:'STALE_RECORD'});
    expect((await snapshotStore(c,'people').original(refs[1]!,providers.people)).ref).toEqual(refs[1]);
    const before=(await snapshotStore(c,'people').read())!;phase=2;expect((await syncSources(c,undefined,factory)).ok).toBe(false);
    const retained=await search({source:'people',query:''});expect(retained.totalMatches).toBe(1);expect(retained.coverage.asOf).toBe(before.checkedAt);expect(retained.coverage.lastError.code).toBe('SYNC_STATE_EXPIRED');
    expect((await createRuntime(c).list_sources()).sources.find(s=>s.source==='people')!.freshness.lastAttemptAt).toBeDefined();
  }finally{await client?.close();await rm(root,{recursive:true,force:true});}
});

test('Google calendars paginate empty pages, expand all-day timezone, apply cancellations and recover expired tokens',async()=>{
  let phase=0;const seen:string[]=[];
  const provider=googleCalendarProvider('agenda',['cal'],windowOptions,async path=>{
    seen.push(path);
    if(path.startsWith('/users/'))return {items:[{id:'cal',summary:'Research',timeZone:'America/New_York'}]};
    if(path.endsWith('/events/event'))return event;
    if(path.includes('syncToken=')){if(phase===2)throw expired();return {items:[{id:'event',status:'cancelled'}],nextSyncToken:'two'};}
    expect(path).toContain('singleEvents=true');expect(path).toContain('timeMin=');
    return path.includes('pageToken=')?{items:[event],nextSyncToken:'one'}:{nextPageToken:'next'};
  });
  const full=await provider.sync();expect(full.records).toHaveLength(1);expect(full.records[0]!.occurredAt).toBe('2026-10-24T04:00:00Z');
  expect((await provider.read(full.records[0]!.ref.id)).ref.version).toBe(full.records[0]!.ref.version);
  phase=1;expect((await provider.sync(full.checkpoint)).records).toEqual([]);
  expect(seen.find(p=>p.includes('syncToken='))).not.toContain('timeMin');
  phase=2;expect((await provider.sync(full.checkpoint)).records).toHaveLength(1);
  expect(calendarWindow({pastDays:1,futureDays:1},new Date('2026-10-24T18:00:00Z'))).toEqual({from:'2026-10-23T00:00:00.000Z',to:'2026-10-25T00:00:00.000Z'});
  expect(timestamp('2026-03-08T09:00:00','America/New_York')).toBe('2026-03-08T13:00:00Z');
});

test('Google contacts retain complete state across pages, tombstones and expired sync recovery',async()=>{
  let phase=0;
  const person={resourceName:'people/invented',names:[{displayName:'Invented Astronomer'}],emailAddresses:[{value:'astronomer@example.test'}]};
  const provider=googleContactsProvider('people',async path=>{
    if(path.startsWith('/people/invented?'))return person;
    if(phase===1)return {connections:[{resourceName:person.resourceName,metadata:{deleted:true}}],nextSyncToken:'two'};
    if(phase===2&&path.includes('syncToken='))throw expired();
    return path.includes('pageToken=')?{connections:[person],nextSyncToken:'one'}:{nextPageToken:'more'};
  });
  const full=await provider.sync();expect(full.records).toHaveLength(1);expect((await provider.read(full.records[0]!.ref.id)).body).toContain('astronomer@example.test');
  phase=1;expect((await provider.sync(full.checkpoint)).records).toHaveLength(0);
  phase=2;expect((await provider.sync(full.checkpoint)).records).toHaveLength(1);
  await expect(googleContactsProvider('people',async()=>({})).sync()).rejects.toMatchObject({code:'INCOMPLETE_SOURCE'});
});

test('Outlook uses primary-calendar deltas and complete secondary views; patches preserve event fields',async()=>{
  let phase=0;const seen:string[]=[];
  const item={id:'e',subject:'Invented prism',start:{dateTime:'2026-10-24T13:00:00',timeZone:'UTC'},end:{dateTime:'2026-10-24T14:00:00',timeZone:'UTC'}};
  const provider=microsoftCalendarProvider('outlook',undefined,windowOptions,async path=>{
    seen.push(path);if(path==='/me/calendars')return {value:[{id:'main',name:'Main',isDefaultCalendar:true},{id:'other',name:'Other'}]};
    if(path.includes('/events/'))return item;
    if(path.startsWith('/me/calendars/other/calendarView'))return {value:phase===2?[]:[item]};
    return {value:phase===0?[item]:phase===1?[{id:'e',subject:'Changed prism'}]:[{id:'e','@removed':{reason:'deleted'}}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=next'};
  });
  const first=await provider.sync();expect(first.records).toHaveLength(2);expect(first.strategy).toBe('delta-and-window-inventory');
  phase=1;const second=await provider.sync(first.checkpoint);expect(second.records[0]!.title).toBe('Changed prism');expect(second.records[0]!.occurredAt).toBe('2026-10-24T13:00:00Z');
  expect(seen.some(v=>v.includes('$deltatoken=next'))).toBe(true);
  phase=2;expect((await provider.sync(second.checkpoint)).records).toHaveLength(0);
  await expect(graphPages(async()=>({value:[],'@odata.nextLink':'https://other.example.test/v1.0/me/calendars'}),'/me/calendars')).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
});

test('Outlook contacts include default and nested folders and use folder deltas with deletions',async()=>{
  let phase=0;
  const provider=microsoftContactsProvider('outlook',undefined,async path=>{
    if(path==='/me/contactFolders')return {value:[{id:'folder',displayName:'Lab'}]};
    if(path.endsWith('/childFolders'))return {value:[]};
    if(path.startsWith('/me/contacts?$top='))return {value:[{parentFolderId:'native-default'}]};
    if(path.endsWith('/contacts/contact'))return {id:'contact',displayName:'Invented Optician'};
    expect(path).toContain('/contacts/delta');
    return {value:phase?[{id:'contact','@removed':{}}]:[{id:'contact',displayName:'Invented Optician',emailAddresses:[{address:'optics@example.test'}]}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0'+path.split('?')[0]+'?$deltatoken=next'};
  });
  const first=await provider.sync();expect(first.records).toHaveLength(2);expect(new Set(first.records.map(v=>v.ref.id)).size).toBe(2);
  expect((await provider.read(first.records[0]!.ref.id)).title).toBe('Invented Optician');
  phase=1;expect((await provider.sync(first.checkpoint)).records).toHaveLength(0);
});

test('connected sources share runtime groups, readonly scopes, bounded coverage and retained snapshots after failure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-pim-'));
  try{
    const definition={adapter:'calendars',connector:{type:'google',account:'invented',token:{env:'INVENTED_GOOGLE_TOKEN'}}};
    const c=configSchema.parse({enabledSources:['agenda'],maintenanceEnabled:true,libraryRoot:root,sources:{agenda:definition}});
    const rotated=configSchema.parse({...c,sources:{agenda:{...definition,connector:{...definition.connector,token:{env:'ROTATED_TOKEN'}}}}});
    expect(sourceScope(c,'agenda')).toBe(sourceScope(rotated,'agenda'));expect(sourceAuthorization(c,'agenda').scopes).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
    const largerBudget=configSchema.parse({...c,sources:{agenda:{...definition,sync:{timeoutMs:1800000,maxRequests:20000}}}});
    expect(sourceScope(c,'agenda')).toBe(sourceScope(largerBudget,'agenda'));
    const provider=googleCalendarProvider('agenda',undefined,windowOptions,async path=>path.startsWith('/users/')?{items:[{id:'cal',summary:'Lab'}]}:{items:[event],nextSyncToken:'one'});
    expect((await syncSources(c,undefined,()=>provider)).ok).toBe(true);
    const runtime=createRuntime(c);expect((await runtime.search_sources({queries:[{source:'all-calendars',query:'telescope'}]})).results[0]!.items).toHaveLength(1);
    expect((await syncSources(c,undefined,()=>({...provider,async sync(){throw expired();}}))).ok).toBe(false);
    const page=(await runtime.search_sources({queries:[{source:'agenda',query:'telescope'}]})).results[0]!;
    expect(page.items).toHaveLength(1);expect(page.warnings.join(' ')).toContain('SYNC_STATE_EXPIRED');
    const outside=(await runtime.search_sources({queries:[{source:'agenda',query:'telescope',from:'1800-01-01T00:00:00Z'}]})).results[0]!;
    expect(outside.warnings.join(' ')).toContain('widen the configured window');
  }finally{await rm(root,{recursive:true,force:true});}
});
