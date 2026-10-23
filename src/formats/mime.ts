import {MailParser,type Headers,type HeaderLines,type AddressObject,type EmailAddress,type MessageText,type AttachmentStream} from 'mailparser';
import type {Participant} from '../vendor/source-types';
import {stripHtml} from './html';

export async function parseMimeMessage(bytes:Uint8Array){
  const parser=new MailParser({skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
  let headers:Headers=new Map(),lines:HeaderLines=[],text='',html='';
  await new Promise<void>((resolve,reject)=>{
    parser.on('headers',value=>{headers=value;});
    parser.on('headerLines',value=>{lines=value;});
    parser.on('error',reject);
    parser.on('data',(part:MessageText|AttachmentStream)=>{
      if(part.type==='attachment'){
        // Consume without buffering, saving, or indexing attachment contents.
        part.content.once('error',(error:Error)=>parser.destroy(error));
        part.content.once('end',()=>part.release?.());
        part.content.resume();
      }else{text=part.text||'';html=typeof part.html==='string' ? part.html : '';}
    });
    parser.once('end',resolve);
    parser.end(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
  });
  const rawHeaders:Record<string,string[]>={};
  for(const {key,line} of lines)(rawHeaders[key]??=[]).push(line.slice(line.indexOf(':')+1).replace(/\r?\n[ \t]+/g,' ').trim());
  const addresses=(key:string,role:Participant['role']):Participant[]=>{
    const value=headers.get(key) as AddressObject|undefined;
    const flatten=(list:EmailAddress[]):Participant[]=>list.flatMap(a=>a.group ? flatten(a.group) : a.address ? [{id:a.address,...(a.name ? {displayName:a.name} : {}),role}] : []);
    return flatten(value?.value||[]);
  };
  const from=addresses('from','author'),to=[...addresses('to','recipient'),...addresses('cc','recipient')];
  const format=(a:Participant)=>a.displayName ? `${a.displayName} <${a.id}>` : a.id;
  const date=headers.get('date'),messageId=headers.get('message-id');
  return {headers:rawHeaders,subject:String(headers.get('subject')||''),from:from.map(format).join(', '),to:to.map(format),
    labels:(rawHeaders['x-gmail-labels']?.[0]||'').split(',').map(s=>s.trim()).filter(Boolean),
    ...(typeof messageId==='string' ? {messageId} : {}),...(date instanceof Date && Number.isFinite(date.getTime()) ? {occurredAt:date} : {}),
    dateValue:rawHeaders.date?.[0],bodyText:text.trim() ? text : stripHtml(html),bodyHtml:html||undefined,participants:[...from,...to],warnings:[] as string[]};
}
