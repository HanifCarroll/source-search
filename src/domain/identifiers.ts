import {z} from 'zod';
import type {RecordIdentifier} from './contracts';

export function normalizeIdentifier(kind:RecordIdentifier['kind'], input:string):string|undefined {
  const value=input.trim();
  if(kind==='email') {
    const email=value.replace(/^mailto:/i,'');
    if(!z.email().safeParse(email).success)return;
    const at=email.lastIndexOf('@');
    // Preserve the local part: providers may distinguish case, dots and plus tags.
    return email.slice(0,at)+'@'+email.slice(at+1).toLowerCase();
  }
  if(kind==='phone') {
    const phone=value.replace(/^tel:/i,'').replace(/[\s().-]/g,'');
    return /^\+[1-9]\d{6,14}$/.test(phone)?phone:undefined;
  }
  return value || undefined;
}

export function identifiers(kind:RecordIdentifier['kind'], values:readonly unknown[]):RecordIdentifier[] {
  return [...new Set(values.flatMap(value=>typeof value==='string'?[normalizeIdentifier(kind,value)].filter((v):v is string=>!!v):[]))].map(value=>({kind,value}));
}
