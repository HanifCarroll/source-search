import {z} from 'zod';
import type {HttpRead} from '../../platform/http';
import {fail} from '../../domain/identity';
import {readableHtml} from '../../formats/html';
import {checked,identity,identityParts,collectionLink} from '../sync/paging';
import {graphPages,graphOrigin} from '../sync/graph';
import type {SourceProvider} from '../sync/model';
import {calendarWindow,eventRecord,contactRecord,timestamp,withinWindow} from './model';

const id=z.string().min(1),raw=z.record(z.string(),z.any());
const groupState=z.object({id,token:z.string().optional(),items:z.array(raw)});
const state=z.object({version:z.literal(1),window:z.object({from:z.string(),to:z.string()}).optional(),groups:z.array(groupState)});
const pathId=(value:string)=>encodeURIComponent(value);
function choose<T extends {id:string}>(available:T[],selected?:string[]){
  if(selected?.some(id=>!available.some(v=>v.id===id)))fail('SOURCE_UNAVAILABLE','A selected Microsoft collection is missing or inaccessible');
  return available.filter(v=>!selected||selected.includes(v.id));
}
async function delta(http:HttpRead,collection:string,fullPath:string,prior:z.infer<typeof groupState>|undefined){
  let reset=!prior?.token,result;
  try{result=await graphPages(http,collection,prior?.token?collectionLink(graphOrigin+prior.token,graphOrigin,collection):fullPath,true);}
  catch(e){if((e as any).code!=='SYNC_STATE_EXPIRED'||!prior?.token)throw e;reset=true;result=await graphPages(http,collection,fullPath,true);}
  const map=new Map((reset?[]:prior!.items).map(v=>[v.id,v]));
  for(const item of result.items){const key=checked(id,item.id);if(item['@removed'])map.delete(key);else map.set(key,{...map.get(key),...item});}
  return {items:[...map.values()],token:result.checkpoint};
}

export function microsoftCalendarProvider(source:string,selected:string[]|undefined,windowOptions:{pastDays:number;futureDays:number},http:HttpRead):SourceProvider{
  async function inventory(){return checked(z.array(z.object({id,name:z.string(),isDefaultCalendar:z.boolean().optional()})),(await graphPages(http,'/me/calendars')).items);}
  function record(c:{id:string;name:string},value:unknown){
    const item=checked(z.object({id,subject:z.string(),start:z.object({dateTime:z.string(),timeZone:z.string()}),end:z.object({dateTime:z.string(),timeZone:z.string()}),isAllDay:z.boolean().optional(),body:z.object({contentType:z.string(),content:z.string()}).optional(),location:z.object({displayName:z.string().optional()}).optional(),attendees:z.array(z.object({emailAddress:z.object({name:z.string().optional(),address:z.string().optional()})})).optional(),webLink:z.string().optional(),seriesMasterId:z.string().optional()}),value);
    return eventRecord(source,'microsoft',{id:identity([c.id,item.id]),title:item.subject,calendar:c.name,start:timestamp(item.start.dateTime,item.start.timeZone),end:timestamp(item.end.dateTime,item.end.timeZone),allDay:item.isAllDay,description:item.body?.contentType==='html'?readableHtml(item.body.content):item.body?.content,location:item.location?.displayName,attendees:item.attendees?.map(a=>[a.emailAddress.name,a.emailAddress.address].filter(Boolean).join(' ')),url:item.webLink,recurrence:item.seriesMasterId?'Occurrence of '+item.seriesMasterId:undefined});
  }
  return {async lists(){return (await inventory()).map(c=>({id:c.id,name:c.name}));},async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined,window=calendarWindow(windowOptions),groups=[];
    const records=[];let fullOnly=false;
    for(const c of choose(await inventory(),selected)){
      const prior=old?.window?.from===window.from&&old?.window?.to===window.to?old.groups.find(g=>g.id===c.id):undefined;
      const view='/me/calendars/'+pathId(c.id)+'/calendarView',params='?startDateTime='+encodeURIComponent(window.from)+'&endDateTime='+encodeURIComponent(window.to);
      let result:{items:Record<string,any>[];token?:string};
      if(c.isDefaultCalendar){
        try{result=await delta(http,'/me/calendarView/delta','/me/calendarView/delta'+params,prior);}
        catch(e){if(![400,403,405,501].includes((e as any).httpStatus))throw e;fullOnly=true;result={items:(await graphPages(http,view,view+params)).items};}
      }else{fullOnly=true;result={items:(await graphPages(http,view,view+params)).items};}
      const items=result.items.filter(v=>!v.isCancelled).filter(v=>{const r=record(c,v);return withinWindow(r.occurredAt!,String(r.metadata!.endedAt),window);});
      groups.push({id:c.id,token:result.token,items});records.push(...items.map(v=>record(c,v)));
    }
    return {records,coverageWindow:window,checkpoint:{version:1,window,groups},strategy:fullOnly?'delta-and-window-inventory':'delta',coverage:`Selected Outlook calendar occurrences from ${window.from} to ${window.to}; nondefault calendars use complete views because v1.0 delta is documented for the primary calendar`,warnings:[]};
  },async read(ref){
    const [calendarId,eventId]=identityParts(ref,2),c=choose(await inventory(),selected).find(c=>c.id===calendarId);if(!c)fail('RECORD_NOT_FOUND','Calendar is no longer selected');
    const item=checked(raw,await http('/me/calendars/'+pathId(calendarId!)+'/events/'+pathId(eventId!)));if(item.id!==eventId||item.isCancelled)fail('RECORD_NOT_FOUND','Event was removed');return record(c,item);
  }};
}

type Book={id:string;name:string};
const contactPath=(book:string)=>book==='default'?'/me/contacts':'/me/contactFolders/'+pathId(book)+'/contacts';
export function microsoftContactsProvider(source:string,selected:string[]|undefined,http:HttpRead):SourceProvider{
  async function inventory(){
    const result:Book[]=[{id:'default',name:'Contacts'}],seen=new Set<string>(),queue=['/me/contactFolders'];
    while(queue.length){
      const path=queue.shift()!;
      const folders=checked(z.array(z.object({id,displayName:z.string()})),(await graphPages(http,path)).items);
      for(const f of folders){if(seen.has(f.id))fail('INVALID_PROVIDER_RESPONSE','Microsoft repeated a contact folder');seen.add(f.id);result.push({id:f.id,name:f.displayName});queue.push('/me/contactFolders/'+pathId(f.id)+'/childFolders');}
      if(result.length>1000)fail('SOURCE_LIMIT','Microsoft has more than 1,000 contact folders');
    }
    return result;
  }
  function record(book:Book,value:unknown){
    const p=checked(z.object({id,displayName:z.string().nullish(),givenName:z.string().nullish(),surname:z.string().nullish(),emailAddresses:z.array(z.object({address:z.string().nullish(),name:z.string().nullish()})).optional(),businessPhones:z.array(z.string()).optional(),homePhones:z.array(z.string()).optional(),mobilePhone:z.string().nullish(),companyName:z.string().nullish(),jobTitle:z.string().nullish(),personalNotes:z.string().nullish(),birthday:z.string().nullish(),homeAddress:raw.optional(),businessAddress:raw.optional(),otherAddress:raw.optional(),businessHomePage:z.string().nullish()}),value);
    const fields=[...(p.emailAddresses||[]).map(v=>'Email: '+v.address),...(p.businessPhones||[]).map(v=>'Work phone: '+v),...(p.homePhones||[]).map(v=>'Home phone: '+v),p.mobilePhone&&'Mobile: '+p.mobilePhone,p.companyName&&'Organization: '+p.companyName,p.jobTitle&&'Title: '+p.jobTitle,p.personalNotes&&'Note: '+readableHtml(p.personalNotes),p.birthday&&'Birthday: '+p.birthday,p.businessHomePage&&'URL: '+p.businessHomePage,...[p.homeAddress,p.businessAddress,p.otherAddress].filter(Boolean).map(a=>'Address: '+Object.values(a!).filter(Boolean).join(', '))].filter((v):v is string=>!!v);
    return contactRecord(source,'microsoft',{id:identity([book.id,p.id]),name:p.displayName||[p.givenName,p.surname].filter(Boolean).join(' ')||p.emailAddresses?.[0]?.address||'',book:book.name,fields});
  }
  return {lists:inventory,async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined,groups=[],records=[];
    for(const book of choose(await inventory(),selected)){
      const prior=old?.groups.find(g=>g.id===book.id);let collection=contactPath(book.id),result:{items:Record<string,any>[];token?:string};
      if(book.id==='default'){
        // Graph lists child folders separately. Discover the default folder's
        // native ID from a contact so its documented folder delta can be used.
        const first=checked(z.object({value:z.array(z.object({parentFolderId:id}))}),await http('/me/contacts?$top=1&$select=parentFolderId'));
        if(first.value[0])collection='/me/contactFolders/'+pathId(first.value[0].parentFolderId)+'/contacts';
      }
      if(book.id==='default'&&collection==='/me/contacts')result={items:(await graphPages(http,collection)).items};
      else result=await delta(http,collection+'/delta',collection+'/delta',prior);
      groups.push({id:book.id,...result});records.push(...result.items.map(v=>record(book,v)));
    }
    return {records,checkpoint:{version:1,groups},strategy:'folder-delta',coverage:'Outlook saved contacts in the selected default or nested folders; organization directory is not included',warnings:[]};
  },async read(ref){
    const [bookId,contactId]=identityParts(ref,2),book=choose(await inventory(),selected).find(b=>b.id===bookId);if(!book)fail('RECORD_NOT_FOUND','Contact folder is no longer selected');
    const p=checked(raw,await http(contactPath(bookId!)+'/'+pathId(contactId!)));if(p.id!==contactId)fail('INVALID_PROVIDER_RESPONSE','Microsoft returned a different contact');return record(book,p);
  }};
}
