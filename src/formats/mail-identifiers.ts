import {simpleParser} from 'mailparser';
import {identifiers} from '../domain/identifiers';
import type {RecordData} from '../domain/contracts';

// Parse address headers with the same maintained MIME parser used by IMAP.
// Message bodies, display names and quoted messages never establish identity.
export async function mailIdentifiers(record:RecordData) {
  const header=(value:unknown):string=>Array.isArray(value)?value.map(header).join(', '):typeof value==='string'?value.replace(/[\r\n]+/g,' '):'';
  const mail=await simpleParser(`From: ${header(record.author)}\r\nTo: ${header(record.metadata?.to)}\r\nCc: ${header(record.metadata?.cc)}\r\n\r\n`,{skipHtmlToText:true,skipTextToHtml:true});
  const addresses=(values:readonly {address?:string;group?:{address?:string}[]}[]):unknown[]=>values.flatMap(v=>v.group?addresses(v.group):[v.address]);
  return identifiers('email',[mail.from,mail.to,mail.cc].flatMap(field=>(Array.isArray(field)?field:field?[field]:[]).flatMap(v=>addresses(v.value))));
}
