import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {googleCalendarProvider,googleContactsProvider} from '../src/sources/pim/google';
import {microsoftCalendarProvider,microsoftContactsProvider} from '../src/sources/pim/microsoft';
import {calendarWindow,timestamp} from '../src/sources/pim/model';
import {graphPages} from '../src/sources/sync/graph';
import {configSchema,sourceScope} from '../src/platform/config';
import {syncConnected} from '../src/maintenance/connected';
import {createRuntime} from '../src/application/runtime';
import {sourceAuthorization} from '../src/platform/source-auth';

const windowOptions={pastDays:36500,futureDays:36500};
const event={id:'event',summary:'Invented telescope',start:{date:'2026-10-24'},end:{date:'2026-10-25'}};
const expired=()=>Object.assign(new Error('Expired'),{code:'SYNC_STATE_EXPIRED'});

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
    expect((await syncConnected(c,undefined,()=>provider)).ok).toBe(true);
    const runtime=createRuntime(c);expect((await runtime.search_sources({queries:[{source:'all-calendars',query:'telescope'}]})).results[0]!.items).toHaveLength(1);
    expect((await syncConnected(c,undefined,()=>({...provider,async sync(){throw expired();}}))).ok).toBe(false);
    const page=(await runtime.search_sources({queries:[{source:'agenda',query:'telescope'}]})).results[0]!;
    expect(page.items).toHaveLength(1);expect(page.warnings.join(' ')).toContain('SYNC_STATE_EXPIRED');
    const outside=(await runtime.search_sources({queries:[{source:'agenda',query:'telescope',from:'1800-01-01T00:00:00Z'}]})).results[0]!;
    expect(outside.warnings.join(' ')).toContain('widen the configured window');
  }finally{await rm(root,{recursive:true,force:true});}
});
