// Calendar ranges include events crossing the lower bound. End times are
// exclusive; zero-duration events match the instant at which they occur.
export function overlaps(start:unknown,end:unknown,range:{from?:string;to?:string}){
  if(!range.from&&!range.to)return true;
  if(typeof start!=='string'||typeof end!=='string')return false;
  const a=Date.parse(start),b=Date.parse(end);
  return Number.isFinite(a)&&Number.isFinite(b)&&b>=a
    &&(!range.from||(b===a?a>=Date.parse(range.from):b>Date.parse(range.from)))&&(!range.to||a<Date.parse(range.to));
}
