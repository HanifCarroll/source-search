import ICAL from 'ical.js';
import {Temporal} from '@js-temporal/polyfill';
import {textFile} from '../../platform/source-files';
import {parseCalendarComponent} from '../../formats/calendar';
import type {Config} from '../../platform/config';
import type {Query,Ref,RecordData} from '../../domain/contracts';
import {hash,versioned,fail,now,assertVersion} from '../../domain/identity';
import {recordPage} from '../../domain/pages';
import {readableHtml} from '../../formats/html';
function settings(c:Config,id:string){const s=c.sources[id];if(s?.adapter!=='ical'&&s?.adapter!=='vcard')return fail('SOURCE_NOT_CONFIGURED','Select calendar or contact files');return s;}
function instant(t:ICAL.Time,zone:string){
 if(t.zone===ICAL.Timezone.utcTimezone || t.zone!==ICAL.Timezone.localTimezone && t.zone.tzid!=='floating')return new Date(t.toUnixTime()*1000).toISOString();
 return Temporal.ZonedDateTime.from({timeZone:zone,year:t.year,month:t.month,day:t.day,hour:t.hour,minute:t.minute,second:t.second}).toInstant().toString();
}
const encode=(identity:unknown)=>Buffer.from(JSON.stringify(identity)).toString('base64url');
async function records(c:Config,source:string,range?:{from:string;to:string}){
 const s=settings(c,source),result:RecordData[]=[],warnings:string[]=[];
 const seen=new Set<string>();let examined=0;
 const add=(record:RecordData)=>{if(seen.has(record.ref.id))fail('INVALID_ARCHIVE','Duplicate UID in the same source file');seen.add(record.ref.id);if(result.length>=20000)fail('SOURCE_LIMIT','Calendar/contact files exceed 20,000 results; select fewer files or a narrower calendar window');result.push(record);};
 for(const path of s.paths){
  const text=await textFile(path,8*1024*1024),file=hash(path);
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
   if(!range)continue;
   const cal=parseCalendarComponent(text),components=cal.getAllSubcomponents('vevent');
   for(const component of components.filter(p=>!p.hasProperty('recurrence-id'))){
    const event=new ICAL.Event(component),uid=event.uid;
    if(!uid||!component.hasProperty('dtstart'))fail('INVALID_ARCHIVE','Calendar event needs UID and DTSTART');
    const zone=String(component.getFirstProperty('dtstart')?.getParameter('tzid')||s.timeZone||c.timeZone);
    const backwardShift=Math.max(0,...components.filter(e=>e.getFirstPropertyValue('uid')===uid && e.hasProperty('recurrence-id') && e.hasProperty('dtstart')).map(e=>Date.parse(instant(e.getFirstPropertyValue('recurrence-id') as ICAL.Time,zone))-Date.parse(instant(e.getFirstPropertyValue('dtstart') as ICAL.Time,zone))));
    const iterator=event.iterator();let occurrence:ICAL.Time|null;
    while((occurrence=iterator.next())){
     if(++examined>100000)fail('SOURCE_LIMIT','Calendar recurrence exceeds the expansion budget');
     const detail=event.getOccurrenceDetails(occurrence),start=instant(detail.startDate,zone),end=instant(detail.endDate,zone);
     if(Date.parse(instant(occurrence,zone))>=Date.parse(range.to)+backwardShift)break;
     if(Date.parse(start)<Date.parse(range.from)||Date.parse(start)>=Date.parse(range.to))continue;
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
export async function filePimStatus(c:Config,id:string){const s=settings(c,id);for(const path of s.paths){const text=await textFile(path,8*1024*1024);if(s.adapter==='ical')parseCalendarComponent(text);else if(!/BEGIN:VCARD/i.test(text))fail('INVALID_ARCHIVE','Missing contact cards');}return {available:true,files:s.paths.length,coverage:s.adapter==='ical'?'Selected calendar exports with recurring occurrences in the requested date window':'Selected contact files',warnings:[]};}
export async function searchFilePim(c:Config,q:Query){const s=settings(c,q.source);if(q.conversation)fail('UNSUPPORTED_FILTER','Calendar/contact files have no conversation filter');if(s.adapter==='ical'&&(!q.from||!q.to))fail('REQUIRED_FILTER','Calendar files require from and to timestamps');if(s.adapter==='vcard'&&(q.from||q.to))fail('UNSUPPORTED_FILTER','Contacts have no occurrence dates');const r=await records(c,q.source,q.from&&q.to?{from:q.from,to:q.to}:undefined);return recordPage(r.records,q,r.warnings,false);}
export async function readFilePim(c:Config,ref:Ref){let id:any;try{id=JSON.parse(Buffer.from(ref.id,'base64url').toString());if(typeof id.file!=='string'||typeof id.uid!=='string')throw Error();}catch{fail('INVALID_REFERENCE','Invalid calendar/contact reference');}const s=settings(c,ref.source);let range;if(s.adapter==='ical'){const at=Date.parse(id.at);if(!Number.isFinite(at))fail('INVALID_REFERENCE','Calendar reference lacks its occurrence time');range={from:new Date(at).toISOString(),to:new Date(at+1000).toISOString()};}const r=(await records(c,ref.source,range)).records.find(r=>r.ref.id===ref.id);if(!r)fail('NOT_FOUND','Record is absent from the selected files');assertVersion(ref,r.ref.version!);return r;}
