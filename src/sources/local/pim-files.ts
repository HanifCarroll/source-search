import {parsePimText} from '../../formats/pim';
import {textFile} from '../../platform/source-files';
import {parseCalendarComponent} from '../../formats/calendar';
import type {Config} from '../../platform/config';
import type {Query,Ref,RecordData} from '../../domain/contracts';
import {fail,assertVersion} from '../../domain/identity';
import {recordPage} from '../../domain/pages';
function settings(c:Config,id:string){const s=c.sources[id];if(s?.adapter!=='ical'&&s?.adapter!=='vcard')return fail('SOURCE_NOT_CONFIGURED','Select calendar or contact files');return s;}
export async function filePimRecords(c:Config,source:string,range?:{from:string;to:string}){
 const s=settings(c,source),records:RecordData[]=[],warnings:string[]=[];
 for(const path of s.paths){const parsed=parsePimText(await textFile(path,8*1024*1024),{source,path,format:s.adapter,timeZone:s.adapter==='ical'?s.timeZone||c.timeZone:c.timeZone,range});records.push(...parsed.records);warnings.push(...parsed.warnings);if(records.length>20000)fail('SOURCE_LIMIT','Calendar/contact files exceed 20,000 results; select fewer files or a narrower calendar window');}
 if(new Set(records.map(r=>r.ref.id)).size!==records.length)fail('INVALID_ARCHIVE','Duplicate UID in the same source file');
 return {records,warnings:[...new Set(warnings)]};
}
export async function filePimStatus(c:Config,id:string){const s=settings(c,id);for(const path of s.paths){const text=await textFile(path,8*1024*1024);if(s.adapter==='ical')parseCalendarComponent(text);else if(!/BEGIN:VCARD/i.test(text))fail('INVALID_ARCHIVE','Missing contact cards');}return {available:true,files:s.paths.length,coverage:s.adapter==='ical'?'Selected calendar exports with recurring occurrences in the requested date window':'Selected contact files',warnings:[]};}
export async function searchFilePim(c:Config,q:Query){const s=settings(c,q.source);if(q.conversation)fail('UNSUPPORTED_FILTER','Calendar/contact files have no conversation filter');if(s.adapter==='ical'&&(!q.from||!q.to))fail('REQUIRED_FILTER','Calendar files require from and to timestamps');if(s.adapter==='vcard'&&(q.from||q.to))fail('UNSUPPORTED_FILTER','Contacts have no occurrence dates');const r=await filePimRecords(c,q.source,q.from&&q.to?{from:q.from,to:q.to}:undefined);return recordPage(r.records,q,r.warnings,false);}
export async function readFilePim(c:Config,ref:Ref){let id:any;try{id=JSON.parse(Buffer.from(ref.id,'base64url').toString());if(typeof id.file!=='string'||typeof id.uid!=='string')throw Error();}catch{fail('INVALID_REFERENCE','Invalid calendar/contact reference');}const s=settings(c,ref.source);let range;if(s.adapter==='ical'){const at=Date.parse(id.at);if(!Number.isFinite(at))fail('INVALID_REFERENCE','Calendar reference lacks its occurrence time');range={from:new Date(at).toISOString(),to:new Date(at+1000).toISOString()};}const r=(await filePimRecords(c,ref.source,range)).records.find(r=>r.ref.id===ref.id);if(!r)fail('NOT_FOUND','Record is absent from the selected files');assertVersion(ref,r.ref.version!);return r;}
