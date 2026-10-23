import {Temporal} from '@js-temporal/polyfill';
// A note's date is interpreted in its configured zone, never the host's zone.
export function noteDate(value:string|undefined,timeZone:string){
 if(!value)return undefined;
 try{
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return Temporal.PlainDate.from(value).toZonedDateTime({timeZone,plainTime:'00:00'}).toString({timeZoneName:'never',calendarName:'never'});
  if(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value))return Temporal.PlainDateTime.from(value.replace(' ','T')).toZonedDateTime(timeZone).toInstant().toString();
  return new Date(Number(Temporal.Instant.from(value).epochMilliseconds)).toISOString();
 }catch{return undefined;}
}
