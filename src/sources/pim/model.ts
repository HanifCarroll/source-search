import {Temporal} from '@js-temporal/polyfill';
import {versioned,now,fail} from '../../domain/identity';
import type {RecordData} from '../../domain/contracts';

export type Window={from:string;to:string};
export function calendarWindow(options:{pastDays:number;futureDays:number},today=new Date()):Window{
  const day=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
  return {from:new Date(day-options.pastDays*86400000).toISOString(),to:new Date(day+options.futureDays*86400000).toISOString()};
}
export function timestamp(value:string,zone='UTC'){
  try{
    if(/^\d{4}-\d{2}-\d{2}$/.test(value))return Temporal.PlainDate.from(value).toZonedDateTime(zone).toInstant().toString();
    if(/(?:Z|[+-]\d\d:\d\d)$/.test(value))return Temporal.Instant.from(value).toString();
    return Temporal.PlainDateTime.from(value).toZonedDateTime(zone).toInstant().toString();
  }catch{return fail('INVALID_PROVIDER_RESPONSE','Provider returned an invalid date or timezone');}
}
export function eventRecord(source:string,provider:string,item:{id:string;title:string;start:string;end:string;allDay?:boolean;description?:string;location?:string;attendees?:string[];calendar:string;url?:string;recurrence?:string}):RecordData{
  return versioned({adapter:'calendars',ref:{source,id:item.id},title:item.title||'(Untitled event)',
    body:[item.title,`Calendar: ${item.calendar}`,`Start: ${item.start}`,`End: ${item.end}`,item.allDay&&'All day',item.location&&`Location: ${item.location}`,item.description,...(item.attendees||[]).map(v=>'Attendee: '+v),item.recurrence&&`Recurrence: ${item.recurrence}`].filter(Boolean).join('\n\n'),
    type:'calendar-event',locator:item.url||`source-search://${source}/${item.id}`,occurredAt:item.start,observedAt:now(),metadata:{provider,endedAt:item.end,allDay:!!item.allDay,calendar:item.calendar}});
}
export function contactRecord(source:string,provider:string,item:{id:string;name:string;book:string;fields:string[];url?:string}):RecordData{
  return versioned({adapter:'address-books',ref:{source,id:item.id},title:item.name||'(Unnamed contact)',body:[item.name,`Address book: ${item.book}`,...item.fields].filter(Boolean).join('\n'),type:'contact',locator:item.url||`source-search://${source}/${item.id}`,observedAt:now(),metadata:{provider,addressBook:item.book}});
}
export const withinWindow=(start:string,end:string,window:Window)=>Date.parse(start)<Date.parse(window.to)&&Date.parse(end)>=Date.parse(window.from);
