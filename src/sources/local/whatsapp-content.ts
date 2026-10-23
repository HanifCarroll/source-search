import ICAL from 'ical.js';
import {Root} from 'protobufjs/light';

// Only the authored poll fields from WhatsApp's iOS receipt envelope are read.
// Unknown receipt/vote fields are skipped by protobufjs.
const Receipt=new Root().addJSON({Option:{fields:{text:{type:'string',id:1}}},Poll:{fields:{question:{type:'string',id:2},options:{rule:'repeated',type:'Option',id:3}}},Receipt:{fields:{poll:{type:'Poll',id:8}}}}).lookupType('Receipt');
type PollReceipt={poll?:{question?:string;options?:{text?:string}[]}};
type Input={messageType?:number|bigint;pollData?:Uint8Array|null;contactCard?:string|null};
export function whatsappStructuredText(row:Input):{text:string;origin?:'poll'|'contact-card';warning?:string}{
  const type=Number(row.messageType);
  if(type!==46 && type!==4)return {text:''};
  try{
    if(type===46){
      if(!row.pollData?.length)return {text:'',warning:'Poll question and options are absent from the local database.'};
      if(row.pollData.length>1024*1024)throw Error('Oversized poll');
      const poll=(Receipt.decode(row.pollData) as unknown as PollReceipt).poll;
      if(!poll?.question?.trim() || !poll.options?.length || poll.options.length>100)throw Error('Incomplete poll');
      const choices=poll.options.map(option=>option.text?.trim());
      if(choices.some(text=>!text) || [poll.question,...choices].some(text=>text!.length>16384 || text!.includes('\ufffd')))throw Error('Invalid poll text');
      return {text:['Poll',poll.question.trim(),...choices.map(text=>'- '+text)].join('\n'),origin:'poll'};
    }
    if(!row.contactCard || row.contactCard.length>1024*1024)throw Error('Missing or oversized contact card');
    const cards=contactComponents(row.contactCard);
    const labels:Record<string,string>={fn:'Name',n:'Name',nickname:'Nickname',tel:'Phone',email:'Email',org:'Organization',title:'Title',adr:'Address',url:'URL',note:'Note'};
    const contacts:string[]=[];
    for(const data of cards){
      const lines:string[]=[];
      const card=new ICAL.Component(ICAL.parse(data));
      if(card.name!=='vcard')throw Error('Expected vCard');
      for(const property of card.getAllProperties()){
        const name=property.name.split('.').at(-1)!;
        const label=labels[name];if(!label || name==='n' && card.hasProperty('fn'))continue;
        const value=property.getValues().flat(3).map(v=>String(v??'').trim()).filter(Boolean).join('; ');
        if(value)lines.push(`${label}: ${value}`);
      }
      if(lines.length)contacts.push([...new Set(lines)].join('\n'));
    }
    if(!contacts.length)throw Error('No contact fields');
    return {text:'Shared contact\n'+contacts.join('\n\n'),origin:'contact-card'};
  }catch{return {text:'',warning:type===46 ? 'Stored poll could not be decoded; original receipt data remains in WhatsApp.' : 'Stored contact card could not be decoded; original card remains in WhatsApp.'};}
}

// WhatsApp stores concatenated cards and sometimes emits legacy PHOTO;BASE64
// or unindented name/note continuations inside a v3 card. Select text fields
// before parsing so malformed binary/photo fields cannot hide contact details.
// ICAL still owns escaping, parameter parsing, structured values and folding.
function contactComponents(value:string){
  const cards:string[]=[],lines:string[]=[];let active=false,keep=false;
  for(const line of value.split(/\r\n|\n|\r/)){
    if(/^BEGIN:VCARD$/i.test(line)){if(active)throw Error('Nested contact');active=true;lines.length=0;lines.push(line);keep=false;continue;}
    if(/^END:VCARD$/i.test(line)){if(!active)throw Error('Unexpected contact end');lines.push(line);cards.push(lines.join('\r\n'));active=false;continue;}
    if(!active)continue;
    const property=/^(?:[a-z0-9-]+\.)?([a-z0-9-]+)[;:]/i.exec(line);
    if(property){
      keep=/^(?:version|fn|n|nickname|tel|email|org|title|adr|url|note)$/i.test(property[1]!);
      if(keep)lines.push(line);
    }else if(keep && line){
      if(/^[ \t]/.test(line))lines.push(line);
      else lines[lines.length-1]+='\\n'+line;
    }
  }
  if(active || !cards.length)throw Error('Incomplete contact card');
  return cards;
}
