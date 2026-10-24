import {z} from 'zod';
import type {HttpRead} from '../../platform/http';
import {fail} from '../../domain/identity';
import {readableHtml} from '../../formats/html';
import {checked,pages,identity,identityParts} from '../sync/paging';
import type {SourceProvider} from '../sync/model';
import {calendarWindow,eventRecord,contactRecord,timestamp,withinWindow} from './model';

const raw=z.record(z.string(),z.any()),id=z.string().min(1);
async function googlePages(http:HttpRead,path:string,field='items'){
  return pages(path,async next=>{
    const page=checked(z.object({items:z.array(raw).optional(),connections:z.array(raw).optional(),nextPageToken:z.string().optional(),nextSyncToken:z.string().optional()}),await http(next));
    return {items:field==='connections'?page.connections||[]:page.items||[],next:page.nextPageToken?path+'&pageToken='+encodeURIComponent(page.nextPageToken):undefined,checkpoint:page.nextPageToken?undefined:page.nextSyncToken};
  });
}
const calendar=z.object({id,summary:z.string(),timeZone:z.string().default('UTC')});
const calendarsState=z.object({version:z.literal(1),window:z.object({from:z.string(),to:z.string()}),calendars:z.array(z.object({id,token:z.string(),events:z.array(raw)}))});
export function googleCalendarProvider(source:string,selected:string[]|undefined,windowOptions:{pastDays:number;futureDays:number},http:HttpRead):SourceProvider{
  async function inventory(){return checked(z.array(calendar),(await googlePages(http,'/users/me/calendarList?maxResults=250')).items);}
  function record(c:z.infer<typeof calendar>,value:unknown){
    const t=checked(z.object({id,summary:z.string().optional(),start:z.object({date:z.string().optional(),dateTime:z.string().optional(),timeZone:z.string().optional()}),end:z.object({date:z.string().optional(),dateTime:z.string().optional(),timeZone:z.string().optional()}),description:z.string().optional(),location:z.string().optional(),htmlLink:z.string().optional(),recurringEventId:z.string().optional(),attendees:z.array(z.object({email:z.string().optional(),displayName:z.string().optional()})).optional()}),value);
    if(!t.start.dateTime&&!t.start.date||!t.end.dateTime&&!t.end.date)fail('INVALID_PROVIDER_RESPONSE','Calendar event has no start or end');
    return eventRecord(source,'google',{id:identity([c.id,t.id]),title:t.summary||'(Untitled event)',start:timestamp(t.start.dateTime||t.start.date!,t.start.timeZone||c.timeZone),end:timestamp(t.end.dateTime||t.end.date!,t.end.timeZone||c.timeZone),allDay:!!t.start.date,calendar:c.summary,description:readableHtml(t.description||''),location:t.location,url:t.htmlLink,attendees:t.attendees?.map(a=>[a.displayName,a.email].filter(Boolean).join(' ')),recurrence:t.recurringEventId?'Occurrence of '+t.recurringEventId:undefined});
  }
  return {async lists(){return (await inventory()).map(c=>({id:c.id,name:c.summary}));},async sync(previous){
    const parsed=calendarsState.safeParse(previous),old=parsed.success?parsed.data:undefined,window=calendarWindow(windowOptions),available=await inventory();
    if(selected?.some(s=>!available.some(c=>c.id===s)))fail('SOURCE_UNAVAILABLE','A selected Google calendar is missing or inaccessible');
    const checkpoint:z.infer<typeof calendarsState>={version:1,window,calendars:[]},records=[];let incremental=false;
    for(const c of available.filter(c=>!selected||selected.includes(c.id))){
      const prior=old?.window.from===window.from&&old?.window.to===window.to?old.calendars.find(v=>v.id===c.id):undefined;
      const base='/calendars/'+encodeURIComponent(c.id)+'/events?maxResults=2500&singleEvents=true&showDeleted=true';
      const full=()=>googlePages(http,base+'&timeMin='+encodeURIComponent(window.from)+'&timeMax='+encodeURIComponent(window.to));
      let result,reset=!prior;
      try{result=prior?await googlePages(http,base+'&syncToken='+encodeURIComponent(prior.token)):await full();}catch(e){if((e as any).code!=='SYNC_STATE_EXPIRED'||!prior)throw e;reset=true;result=await full();}
      if(!result.checkpoint)fail('INCOMPLETE_SOURCE','Google calendar scan ended without a sync token');
      const map=new Map((reset?[]:prior!.events).map(v=>[String(v.id),v]));
      for(const value of result.items){const key=checked(id,value.id);if(value.status==='cancelled')map.delete(key);else map.set(key,value);}
      const events=[...map.values()].filter(v=>{const r=record(c,v);return withinWindow(r.occurredAt!,String(r.metadata!.endedAt),window);});
      checkpoint.calendars.push({id:c.id,token:result.checkpoint,events});records.push(...events.map(v=>record(c,v)));incremental||=!reset;
    }
    return {records,coverageWindow:window,checkpoint,strategy:incremental?'sync-token':'full-window',coverage:`Selected Google calendar occurrences from ${window.from} to ${window.to}; the window advances daily`,warnings:[]};
  },async read(ref){
    const [calendarId,eventId]=identityParts(ref,2),c=(await inventory()).find(c=>c.id===calendarId&&(!selected||selected.includes(c.id)));
    if(!c)fail('RECORD_NOT_FOUND','Calendar is no longer selected or accessible');
    const value=checked(raw,await http('/calendars/'+encodeURIComponent(calendarId!)+'/events/'+encodeURIComponent(eventId!)));
    if(value.id!==eventId||value.status==='cancelled')fail('RECORD_NOT_FOUND','Event was removed');return record(c,value);
  }};
}

const personFields='metadata,names,nicknames,emailAddresses,phoneNumbers,organizations,addresses,biographies,birthdays,urls';
const contactsState=z.object({version:z.literal(1),token:z.string(),people:z.array(raw)});
export function googleContactsProvider(source:string,http:HttpRead):SourceProvider{
  function record(value:unknown){
    const person=checked(raw,value),resource=checked(id,person.resourceName),fields:string[]=[];
    const values=(key:string,format:(v:any)=>string)=>{if(person[key]!==undefined&&!Array.isArray(person[key]))fail('INVALID_PROVIDER_RESPONSE','Invalid contact fields');for(const item of person[key]||[])fields.push(format(item));};
    values('emailAddresses',v=>'Email: '+v.value);values('phoneNumbers',v=>'Phone: '+v.value);values('nicknames',v=>'Nickname: '+v.value);
    values('organizations',v=>'Organization: '+[v.name,v.title,v.department].filter(Boolean).join('; '));values('addresses',v=>'Address: '+[v.formattedValue||v.streetAddress,v.city,v.region,v.postalCode,v.country].filter(Boolean).join(', '));
    values('biographies',v=>'Note: '+readableHtml(v.value||''));values('urls',v=>'URL: '+v.value);values('birthdays',v=>'Birthday: '+[v.date?.year,v.date?.month,v.date?.day].filter(v=>v!==undefined).join('-'));
    return contactRecord(source,'google',{id:resource,name:person.names?.[0]?.displayName||person.emailAddresses?.[0]?.value||'',book:'Google Contacts',fields,url:'https://contacts.google.com/person/'+encodeURIComponent(resource.replace(/^people\//,''))});
  }
  return {async sync(previous){
    const parsed=contactsState.safeParse(previous),old=parsed.success?parsed.data:undefined;
    const base='/people/me/connections?personFields='+personFields+'&pageSize=1000&requestSyncToken=true';let reset=!old,result;
    try{result=await googlePages(http,base+(old?'&syncToken='+encodeURIComponent(old.token):''),'connections');}catch(e){if((e as any).code!=='SYNC_STATE_EXPIRED'||!old)throw e;reset=true;result=await googlePages(http,base,'connections');}
    if(!result.checkpoint)fail('INCOMPLETE_SOURCE','Google contacts scan ended without a sync token');
    const map=new Map((reset?[]:old!.people).map(p=>[p.resourceName,p]));
    for(const person of result.items){const key=checked(id,person.resourceName);if(person.metadata?.deleted)map.delete(key);else map.set(key,person);}
    const people=[...map.values()];return {records:people.map(record),checkpoint:{version:1,token:result.checkpoint,people},strategy:reset?'full-inventory':'sync-token',coverage:'Google saved contacts; other contacts and organization directory are not included',warnings:[]};
  },async read(ref){
    if(!/^people\/[^/\s]+$/.test(ref))fail('INVALID_REFERENCE','Invalid Google contact reference');
    const value=checked(raw,await http('/'+ref.split('/').map(encodeURIComponent).join('/')+'?personFields='+personFields));
    if(value.resourceName!==ref||value.metadata?.deleted)fail('RECORD_NOT_FOUND','Contact was removed');return record(value);
  }};
}
