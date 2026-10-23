import {sourceKind} from '../../domain/source-catalog';
import {databasePath} from '../../platform/config';
import {whatsappStructuredText} from "./whatsapp-content";
import { scanRecords } from "../../domain/scan";
import type { Database } from "bun:sqlite";
import type { Config } from "../../platform/config";
import { createSnapshot, requireColumns } from "../../platform/sqlite";
import { fail, now, versioned, assertVersion } from "../../domain/identity";
import { type Query, type Ref, type RecordData, type Page } from "../../domain/contracts";

function schema(db: Database, source: "whatsapp" | "calls") {
  if (source === "calls") { requireColumns(db, "meetings", ["id", "title", "start_time", "end_time", "raw_transcript", "formatted_notes", "manual_notes", "deleted_at"]); }
  else { requireColumns(db, "ZWAMESSAGE", ["Z_PK", "ZCHATSESSION", "ZSTANZAID", "ZMESSAGEDATE", "ZISFROMME", "ZTEXT", "ZFROMJID", "ZMEDIAITEM"]); requireColumns(db, "ZWACHATSESSION", ["Z_PK", "ZCONTACTJID", "ZPARTNERNAME"]); }
}
// Rebuild cached text when the native record projection changes.
export const databaseProjectionVersion = (source:string,config?:Config) => sourceKind(source,config)==="whatsapp"?4:1;
function whatsappSelect(db: Database) {
  const cols = new Set((db.query("PRAGMA table_info(ZWAMESSAGE)").all() as {name:string}[]).map(c=>c.name));
  const groups = new Set((db.query("PRAGMA table_info(ZWAGROUPMEMBER)").all() as {name:string}[]).map(c=>c.name));
  const media = new Set((db.query("PRAGMA table_info(ZWAMEDIAITEM)").all() as {name:string}[]).map(c=>c.name));
  const info = new Set((db.query("PRAGMA table_info(ZWAMESSAGEINFO)").all() as {name:string}[]).map(c=>c.name));
  const polls=cols.has("ZMESSAGETYPE") && cols.has("ZMESSAGEINFO") && info.has("Z_PK") && info.has("ZRECEIPTINFO");
  const cards=cols.has("ZMESSAGETYPE") && media.has("Z_PK") && media.has("ZVCARDSTRING");
  const captions = cols.has("ZMESSAGETYPE") && media.has("Z_PK") && media.has("ZTITLE");
  // Photo, video and GIF captions are stored separately from message text.
  // Other media titles can be filenames or link previews, not authored messages.
  const participant = cols.has("ZGROUPMEMBER") && groups.has("Z_PK") && groups.has("ZMEMBERJID");
  return `SELECT m.Z_PK pk,m.ZSTANZAID stanza,m.ZMESSAGEDATE date,m.ZISFROMME outgoing,m.ZTEXT text,${captions ? "CASE WHEN m.ZMESSAGETYPE IN (1,2,11) THEN a.ZTITLE END" : "NULL"} caption,${cols.has("ZMESSAGETYPE") ? "m.ZMESSAGETYPE" : "NULL"} messageType,${polls ? "CASE WHEN m.ZMESSAGETYPE=46 THEN i.ZRECEIPTINFO END" : "NULL"} pollData,${cards ? "CASE WHEN m.ZMESSAGETYPE=4 THEN a.ZVCARDSTRING END" : "NULL"} contactCard,m.ZFROMJID sender,m.ZMEDIAITEM media,c.ZCONTACTJID chat,c.ZPARTNERNAME name,${participant ? "g.ZMEMBERJID" : "NULL"} participant,${participant && groups.has("ZCONTACTNAME") ? "g.ZCONTACTNAME" : "NULL"} participantName FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION c ON c.Z_PK=m.ZCHATSESSION${captions || cards ? " LEFT JOIN ZWAMEDIAITEM a ON a.Z_PK=m.ZMEDIAITEM" : ""}${polls ? " LEFT JOIN ZWAMESSAGEINFO i ON i.Z_PK=m.ZMESSAGEINFO" : ""}${participant ? " LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK=m.ZGROUPMEMBER" : ""}`;
}
function rows(db: Database, source: "whatsapp" | "calls", suffix: string, args: any[]) {
  return db.query(source === "calls" ? `SELECT id pk,title,start_time,end_time,raw_transcript,formatted_notes,manual_notes FROM meetings WHERE (deleted_at IS NULL OR deleted_at=0) ${suffix}` : whatsappSelect(db)+` WHERE 1=1 ${suffix}`).all(...args) as any[];
}
function record(family: "whatsapp" | "calls", row: any,source:string=family): RecordData {
  const id = String(row.pk);
  if (family === "calls") {
    const parts = [{kind:"primary" as const,text:"Original transcript\n"+(row.raw_transcript || "")},...(row.formatted_notes ? [{kind:"generated" as const,text:"Generated meeting notes\n"+row.formatted_notes}] : []),...(row.manual_notes ? [{kind:"manual" as const,text:"Manual notes\n"+row.manual_notes}] : [])];
    const body=parts.map(p=>p.text).join("\n\n");let offset=0;
    const sections=parts.map(p=>{const start=offset;offset+=p.text.length+2;return {kind:p.kind,start,end:start+p.text.length};});
    return versioned({adapter:"muesli", ref: { source, id }, body, sections, title: row.title || "(Untitled call)", type: "call-transcript", locator: `source-search://${source}/${id}`, occurredAt: row.start_time && Number.isFinite(Date.parse(row.start_time)) ? new Date(row.start_time).toISOString() : undefined, observedAt: now(),
      conversation: id, metadata: { endedAt: row.end_time, originalTranscript: !!row.raw_transcript, generatedNotesSeparate: true }, warnings: ["Stored automatic transcript may contain recognition or speaker errors; generated notes are labelled separately."] });
  }
  const group = row.chat?.endsWith("@g.us") || false;
  const senderId = group ? row.participant || (row.sender?.endsWith("@g.us") ? undefined : row.sender) : row.sender;
  const actor = row.outgoing === 1n ? "self" : senderId ? row.participantName || (!group && row.name ? row.name : senderId) : "unknown sender";
  const caption = typeof row.caption === "string" ? row.caption.trim() : "";
  const text = row.text || "", distinctCaption = caption && caption !== text.trim();
  const structured=whatsappStructuredText(row);
  const messageBody = distinctCaption ? [text, "Media caption\n" + caption].filter(Boolean).join("\n\n") : text;
  const body=[messageBody,structured.text].filter(Boolean).join("\n\n");
  return versioned({adapter:"whatsapp", ref: { source, id }, body, title: row.name || row.chat || "WhatsApp message", type: "message", locator: `source-search://${source}/${id}`, occurredAt: row.date && Number.isFinite(Number(row.date)) ? new Date(Number(row.date) * 1000 + 978307200000).toISOString() : undefined, observedAt: now(), author: actor, conversation: row.chat,
    metadata: {...(structured.origin ? {textOrigin:structured.origin} : {}), bodyStatus:body.trim() ? "text" : "text-unavailable",...(distinctCaption ? {textOrigin:text.trim() ? "message-and-caption" : "media-caption"} : {}),senderId, senderIdentity: row.outgoing === 1n ? "self" : senderId ? "native" : "unknown", nativeId: row.stanza, direction: row.outgoing === 1n ? "outgoing" : "incoming", group: row.chat?.endsWith("@g.us") || false, hasMedia: row.media != null }, warnings: [...(structured.warning ? [structured.warning] : []),...(row.media != null ? ["Attachment files are not searched; stored message text, captions, polls and contact cards are returned."] : []),...(!body.trim() ? ["This local entry has no readable text; changing search terms cannot recover absent text. It may be a media/system entry or incomplete local history; its kind is not inferred."] : [])] });
}
function family(config:Config,source:string):'whatsapp'|'calls'{const kind=sourceKind(source,config);if(kind!=='whatsapp' && kind!=='muesli')fail('SOURCE_NOT_CONFIGURED','Expected WhatsApp or Muesli source');return kind==='muesli'?'calls':'whatsapp';}
export async function databaseStatus(config:Config,source:string){
 const kind=family(config,source),snap=await createSnapshot(databasePath(config,source));
 try{schema(snap.database,kind);const count=snap.database.query(kind==='calls'?'SELECT count(*) n FROM meetings WHERE deleted_at IS NULL OR deleted_at=0':'SELECT count(*) n FROM ZWAMESSAGE').get() as {n:bigint};return {records:Number(count.n),originalModifiedAt:snap.sourceDatabaseModifiedAt,coverage:kind==='whatsapp'?'Local direct/group message text, captions, polls and contact cards; phone-only history and attachment contents are outside this source':'Current nondeleted Muesli meetings, including complete stored transcripts'};}finally{await snap.close();}
}
export async function searchDatabase(config:Config,q:Query):Promise<Page>{
 const source=q.source,kind=family(config,source),snap=await createSnapshot(databasePath(config,source));
 try{
  schema(snap.database,kind);const conditions=kind==='calls'?['(deleted_at IS NULL OR deleted_at=0)']:[],values:any[]=[];
  if(q.conversation){conditions.push(kind==='calls'?'CAST(id AS TEXT)=?':'c.ZCONTACTJID=?');values.push(q.conversation);}
  const select=kind==='calls'?'SELECT id pk,title,start_time,end_time,raw_transcript,formatted_notes,manual_notes FROM meetings':whatsappSelect(snap.database);
  const page=scanRecords(snap.database,select,conditions,values,kind==='calls'?'julianday(start_time)':'m.ZMESSAGEDATE',kind==='calls'?'id':'m.Z_PK',q,row=>record(kind,row,source));
  page.sourceWarnings=[kind==='whatsapp'?'Local message text, captions, polls and contact cards; attachment contents and phone-only history are excluded.':'Automatic transcript and generated notes are labelled separately.'];return page;
 }finally{await snap.close();}
}
export async function readDatabase(config:Config,ref:Ref,context:boolean){
 const source=ref.source,kind=family(config,source);
 if(!/^\d+$/.test(ref.id) || !Number.isSafeInteger(Number(ref.id)))fail('INVALID_REFERENCE','Expected a safe native row identifier');
 const snap=await createSnapshot(databasePath(config,source));
 try{
  schema(snap.database,kind);const list=rows(snap.database,kind,`AND ${kind==='whatsapp'?'m.Z_PK':'id'}=?`,[ref.id]);
  if(!list.length)fail('RECORD_NOT_FOUND','Record is absent or deleted in the current source');
  const r=record(kind,list[0],source);assertVersion(ref,r.ref.version!);let neighbors:RecordData[]=[];
  if(context && kind==='whatsapp' && r.conversation){
   const previous=rows(snap.database,kind,'AND c.ZCONTACTJID=? AND m.Z_PK<? ORDER BY m.Z_PK DESC LIMIT 5',[r.conversation,ref.id]).reverse();
   const following=rows(snap.database,kind,'AND c.ZCONTACTJID=? AND m.Z_PK>? ORDER BY m.Z_PK ASC LIMIT 5',[r.conversation,ref.id]);neighbors=[...previous,...following].map(row=>record(kind,row,source));
  }
  return {record:r,context:neighbors.map(({body,...r})=>({...r,excerpt:body.slice(0,500)}))};
 }finally{await snap.close();}
}
// One consistent SQLite snapshot for maintenance, without a search/top-N limit.
export async function allDatabaseRecords(config:Config,source:string){
 const kind=family(config,source),snap=await createSnapshot(databasePath(config,source));
 try{schema(snap.database,kind);return rows(snap.database,kind,'',[]).map(row=>record(kind,row,source));}finally{await snap.close();}
}
