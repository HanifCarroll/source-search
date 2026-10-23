import ICAL from 'ical.js';
import {Temporal} from '@js-temporal/polyfill';

export function parseCalendarComponent(text:string){
  // Takeout sometimes omits the whitespace required on continued description
  // lines. Repair only that export quirk before the standards parser runs.
  const lines:string[]=[];
  for(const line of text.replace(/^\uFEFF/,'').split(/\r\n|\n|\r/)){
    if(line && !/^[ \t]/.test(line) && !/^[A-Z0-9-]+[;:]/i.test(line) && lines.length)lines[lines.length-1]+=line;
    else lines.push(line);
  }
  const calendar=new ICAL.Component(ICAL.parse(lines.join('\r\n')));
  if(calendar.name!=='vcalendar')throw Error('Expected VCALENDAR');
  return calendar;
}
export function calendarDate(property:ICAL.Property|null):{date?:Date;raw:string;allDay:boolean;metadata:Record<string,unknown>}|undefined{
  if(!property)return undefined;
  const value=property.getFirstValue();
  if(!(value instanceof ICAL.Time))throw Error('Invalid calendar date');
  const raw=value.toICALString(),allDay=value.isDate,tz=property.getParameter('tzid');
  const timezone=typeof tz==='string' ? tz : undefined;
  const utc=value.zone===ICAL.Timezone.utcTimezone;
  const metadata:Record<string,unknown>={raw,allDay,...(utc ? {zone:'Z'} : {}),...(timezone ? {timezone} : {})};
  if(allDay || !utc && !timezone)return {raw,allDay,metadata};
  let date:Date;
  if(utc || value.zone!==ICAL.Timezone.localTimezone){
    // ICAL resolves embedded VTIMEZONE from this component's parent calendar.
    // Never register it globally: different files can reuse the same TZID.
    date=new Date(value.toUnixTime()*1000);
  }else{
    try{
      const zoned=Temporal.ZonedDateTime.from({timeZone:timezone!,year:value.year,month:value.month,day:value.day,hour:value.hour,minute:value.minute,second:value.second},{disambiguation:'compatible',overflow:'reject'});
      date=new Date(zoned.epochMilliseconds);
    }catch(error){
      if(!(error instanceof RangeError))throw error;
      return {raw,allDay,metadata:{...metadata,unresolvedTimezone:true}};
    }
  }
  return {date,raw,allDay,metadata:{...metadata,iso:date.toISOString()}};
}
