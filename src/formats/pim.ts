import ICAL from 'ical.js';
import {Temporal} from '@js-temporal/polyfill';
import {parseCalendarComponent} from './calendar';
import {readableHtml} from './html';
import {hash,versioned,fail,now} from '../domain/identity';
import {overlaps} from '../domain/date-range';
import type {RecordData} from '../domain/contracts';
function instant(t:ICAL.Time,zone:string){
 if(t.zone===ICAL.Timezone.utcTimezone || t.zone!==ICAL.Timezone.localTimezone && t.zone.tzid!=='floating')return new Date(t.toUnixTime()*1000).toISOString();
 return Temporal.ZonedDateTime.from({timeZone:zone,year:t.year,month:t.month,day:t.day,hour:t.hour,minute:t.minute,second:t.second}).toInstant().toString();
}
const encode=(identity:unknown)=>Buffer.from(JSON.stringify(identity)).toString('base64url');
export function parsePimText(text:string,options:{source:string;path:string;format:'ical'|'vcard';timeZone:string;range?:{from:string;to:string}}){
 const {source,path,range}=options,s={adapter:options.format,timeZone:options.timeZone},result:RecordData[]=[],warnings:string[]=[];
 const seen=new Set<string>();let examined=0;
 const add=(record:RecordData)=>{if(seen.has(record.ref.id))fail('INVALID_ARCHIVE','Duplicate UID in the same source file');seen.add(record.ref.id);if(result.length>=20000)fail('SOURCE_LIMIT','Calendar/contact files exceed 20,000 results; select fewer files or a narrower calendar window');result.push(record);};
 {
  const file=hash(path);
  if(s.adapter==='vcard'){
   const cards=text.match(/BEGIN:VCARD\r?\n[\s\S]*?\r?\nEND:VCARD/gi)||[];
   if(cards.length!==(text.match(/BEGIN:VCARD/gi)||[]).length||!cards.length)fail('INVALID_ARCHIVE','Incomplete or missing contact card');
   for(const raw of cards){
    const card=new ICAL.Component(ICAL.parse(raw));const uid=String(card.getFirstPropertyValue('uid')||hash(raw));
    const title=String(card.getFirstPropertyValue('fn')||card.getFirstPropertyValue('n')||'Contact');
    const labels:Record<string,string>={fn:'Name',n:'Name',nickname:'Nickname',email:'Email',tel:'Phone',org:'Organization',title:'Title',adr:'Address',url:'URL',note:'Note',bday:'Birthday'};
    const body=card.getAllProperties().flatMap(p=>{const label=labels[p.name.split('.').at(-1)!];return label?[`${label}: ${p.getValues().flat(3).join('; ')}`]:[];}).join('\n');
    add(versioned({ref:{source,id:encode({file,uid})},title,body,type:'contact',locator:path+'#'+encodeURIComponent(uid),observedAt:now(),metadata:{format:'vcard'}}));
    if(!card.hasProperty('uid'))warnings.push('A contact without UID uses its content as identity; editing it creates a new reference.');
   }
  }else{
   if(!range)return {records:result,warnings};
   const cal=parseCalendarComponent(text),components=cal.getAllSubcomponents('vevent');
   for(const component of components.filter(p=>!p.hasProperty('recurrence-id'))){
    const event=new ICAL.Event(component),uid=event.uid;
    if(!uid||!component.hasProperty('dtstart'))fail('INVALID_ARCHIVE','Calendar event needs UID and DTSTART');
    const zone=String(component.getFirstProperty('dtstart')?.getParameter('tzid')||s.timeZone);
    const backwardShift=Math.max(0,...components.filter(e=>e.getFirstPropertyValue('uid')===uid && e.hasProperty('recurrence-id') && e.hasProperty('dtstart')).map(e=>Date.parse(instant(e.getFirstPropertyValue('recurrence-id') as ICAL.Time,zone))-Date.parse(instant(e.getFirstPropertyValue('dtstart') as ICAL.Time,zone))));
    const iterator=event.iterator();let occurrence:ICAL.Time|null;
    while((occurrence=iterator.next())){
     if(++examined>100000)fail('SOURCE_LIMIT','Calendar recurrence exceeds the expansion budget');
     const detail=event.getOccurrenceDetails(occurrence),start=instant(detail.startDate,zone),end=instant(detail.endDate,zone);
     if(Date.parse(instant(occurrence,zone))>=Date.parse(range.to)+backwardShift)break;
     if(!overlaps(start,end,range))continue;
     const actual=detail.item.component;if(String(actual.getFirstPropertyValue('status')||'').toUpperCase()==='CANCELLED')continue;
     const title=String(actual.getFirstPropertyValue('summary')||'(Untitled event)'),description=String(actual.getFirstPropertyValue('description')||'');
     const body=[title,`Start: ${start}`,`End: ${end}`,actual.getFirstPropertyValue('location')&&`Location: ${actual.getFirstPropertyValue('location')}`,readableHtml(description),...actual.getAllProperties('attendee').map(p=>'Attendee: '+p.getFirstValue())].filter(Boolean).join('\n\n');
     add(versioned({ref:{source,id:encode({file,uid,occurrence:occurrence.toICALString(),at:start})},title,body,type:'calendar-event',locator:path+'#'+encodeURIComponent(uid),occurredAt:start,observedAt:now(),metadata:{endedAt:end,allDay:detail.startDate.isDate,timezone:zone,format:'ical'}}));
    }
   }
   if(components.some(p=>p.hasProperty('recurrence-id')&&!components.some(master=>!master.hasProperty('recurrence-id')&&master.getFirstPropertyValue('uid')===p.getFirstPropertyValue('uid'))))warnings.push('Calendar contains an exception without its recurring series; export the complete calendar.');
  }
 }
 return {records:result,warnings:[...new Set(warnings)]};
}
