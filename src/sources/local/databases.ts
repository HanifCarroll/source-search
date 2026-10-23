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
export const databaseProjectionVersion = (source: "whatsapp" | "calls") => source === "whatsapp" ? 2 : 1;
function whatsappSelect(db: Database) {
  const cols = new Set((db.query("PRAGMA table_info(ZWAMESSAGE)").all() as {name:string}[]).map(c=>c.name));
  const groups = new Set((db.query("PRAGMA table_info(ZWAGROUPMEMBER)").all() as {name:string}[]).map(c=>c.name));
  const media = new Set((db.query("PRAGMA table_info(ZWAMEDIAITEM)").all() as {name:string}[]).map(c=>c.name));
  const captions = cols.has("ZMESSAGETYPE") && media.has("Z_PK") && media.has("ZTITLE");
  // Photo, video and GIF captions are stored separately from message text.
  // Other media titles can be filenames or link previews, not authored messages.
  const participant = cols.has("ZGROUPMEMBER") && groups.has("Z_PK") && groups.has("ZMEMBERJID");
  return `SELECT m.Z_PK pk,m.ZSTANZAID stanza,m.ZMESSAGEDATE date,m.ZISFROMME outgoing,m.ZTEXT text,${captions ? "CASE WHEN m.ZMESSAGETYPE IN (1,2,11) THEN a.ZTITLE END" : "NULL"} caption,m.ZFROMJID sender,m.ZMEDIAITEM media,c.ZCONTACTJID chat,c.ZPARTNERNAME name,${participant ? "g.ZMEMBERJID" : "NULL"} participant,${participant && groups.has("ZCONTACTNAME") ? "g.ZCONTACTNAME" : "NULL"} participantName FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION c ON c.Z_PK=m.ZCHATSESSION${captions ? " LEFT JOIN ZWAMEDIAITEM a ON a.Z_PK=m.ZMEDIAITEM" : ""}${participant ? " LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK=m.ZGROUPMEMBER" : ""}`;
}
function rows(db: Database, source: "whatsapp" | "calls", suffix: string, args: any[]) {
  return db.query(source === "calls" ? `SELECT id pk,title,start_time,end_time,raw_transcript,formatted_notes,manual_notes FROM meetings WHERE (deleted_at IS NULL OR deleted_at=0) ${suffix}` : whatsappSelect(db)+` WHERE 1=1 ${suffix}`).all(...args) as any[];
}
function record(source: "whatsapp" | "calls", row: any): RecordData {
  const id = String(row.pk);
  if (source === "calls") {
    const parts = [{kind:"primary" as const,text:"Original transcript\n"+(row.raw_transcript || "")},...(row.formatted_notes ? [{kind:"generated" as const,text:"Generated meeting notes\n"+row.formatted_notes}] : []),...(row.manual_notes ? [{kind:"manual" as const,text:"Manual notes\n"+row.manual_notes}] : [])];
    const body=parts.map(p=>p.text).join("\n\n");let offset=0;
    const sections=parts.map(p=>{const start=offset;offset+=p.text.length+2;return {kind:p.kind,start,end:start+p.text.length};});
    return versioned({ ref: { source, id }, body, sections, title: row.title || "(Untitled call)", type: "call-transcript", locator: `source-search://calls/${id}`, occurredAt: row.start_time && Number.isFinite(Date.parse(row.start_time)) ? new Date(row.start_time).toISOString() : undefined, observedAt: now(),
      conversation: id, metadata: { endedAt: row.end_time, originalTranscript: !!row.raw_transcript, generatedNotesSeparate: true }, warnings: ["Stored automatic transcript may contain recognition or speaker errors; generated notes are labelled separately."] });
  }
  const group = row.chat?.endsWith("@g.us") || false;
  const senderId = group ? row.participant || (row.sender?.endsWith("@g.us") ? undefined : row.sender) : row.sender;
  const actor = row.outgoing === 1n ? "self" : senderId ? row.participantName || (!group && row.name ? row.name : senderId) : "unknown sender";
  const caption = typeof row.caption === "string" ? row.caption.trim() : "";
  const text = row.text || "", distinctCaption = caption && caption !== text.trim();
  const body = distinctCaption ? [text, "Media caption\n" + caption].filter(Boolean).join("\n\n") : text;
  return versioned({ ref: { source, id }, body, title: row.name || row.chat || "WhatsApp message", type: "message", locator: `source-search://whatsapp/${id}`, occurredAt: row.date && Number.isFinite(Number(row.date)) ? new Date(Number(row.date) * 1000 + 978307200000).toISOString() : undefined, observedAt: now(), author: actor, conversation: row.chat,
    metadata: { bodyStatus:body.trim() ? "text" : "text-unavailable",...(distinctCaption ? {textOrigin:text.trim() ? "message-and-caption" : "media-caption"} : {}),senderId, senderIdentity: row.outgoing === 1n ? "self" : senderId ? "native" : "unknown", nativeId: row.stanza, direction: row.outgoing === 1n ? "outgoing" : "incoming", group: row.chat?.endsWith("@g.us") || false, hasMedia: row.media != null }, warnings: [...(row.media != null ? ["Attachment files are not searched; stored message text and photo/video captions are returned."] : []),...(!body.trim() ? ["This local entry has no readable text; changing search terms cannot recover absent text. It may be a media/system entry or incomplete local history; its kind is not inferred."] : [])] });
}
function path(config: Config, source: "whatsapp" | "calls") { return source === "whatsapp" ? config.whatsapp : config.muesli; }
export async function databaseStatus(config: Config, source: "whatsapp" | "calls") {
  const snap = await createSnapshot(path(config, source));
  try { schema(snap.database, source); const count = snap.database.query(source === "calls" ? "SELECT count(*) n FROM meetings WHERE deleted_at IS NULL OR deleted_at=0" : "SELECT count(*) n FROM ZWAMESSAGE").get() as { n: bigint }; return { records: Number(count.n), originalModifiedAt: snap.sourceDatabaseModifiedAt, coverage: source === "whatsapp" ? "Local direct/group message text and photo/video captions; phone-only history and attachment contents are outside this source" : "Current nondeleted Muesli meetings, including complete stored transcripts" }; }
  finally { await snap.close(); }
}
export async function searchDatabase(config: Config, q: Query): Promise<Page> {
  const source = q.source as "whatsapp" | "calls", snap = await createSnapshot(path(config, source));
  try {
    schema(snap.database, source);
    const conditions=source === "calls" ? ["(deleted_at IS NULL OR deleted_at=0)"] : [], values:any[]=[];
    if(q.conversation){conditions.push(source === "calls" ? "CAST(id AS TEXT)=?" : "c.ZCONTACTJID=?");values.push(q.conversation);}
    const select=source === "calls" ? "SELECT id pk,title,start_time,end_time,raw_transcript,formatted_notes,manual_notes FROM meetings" : whatsappSelect(snap.database);
    const page=scanRecords(snap.database,select,conditions,values,source === "calls" ? "julianday(start_time)" : "m.ZMESSAGEDATE",source === "calls" ? "id" : "m.Z_PK",q,row=>record(source,row));
    page.sourceWarnings=[source === "whatsapp" ? "Local message text and photo/video captions; attachment contents and phone-only history are excluded." : "Automatic transcript and generated notes are labelled separately."];
    return page;
  } finally { await snap.close(); }
}
export async function readDatabase(config: Config, ref: Ref, context: boolean) {
  const source = ref.source as "whatsapp" | "calls";
  if (!/^\d+$/.test(ref.id) || !Number.isSafeInteger(Number(ref.id))) fail("INVALID_REFERENCE", "Expected a safe native row identifier");
  const snap = await createSnapshot(path(config, source));
  try {
    schema(snap.database, source); const list = rows(snap.database, source, `AND ${source === "whatsapp" ? "m.Z_PK" : "id"}=?`, [ref.id]);
    if (!list.length) fail("RECORD_NOT_FOUND", "Record is absent or deleted in the current source");
    const r = record(source, list[0]); assertVersion(ref, r.ref.version!); let neighbors: RecordData[] = [];
    if (context && source === "whatsapp" && r.conversation) {
      const previous = rows(snap.database, source, "AND c.ZCONTACTJID=? AND m.Z_PK<? ORDER BY m.Z_PK DESC LIMIT 5", [r.conversation, ref.id]).reverse();
      const following = rows(snap.database, source, "AND c.ZCONTACTJID=? AND m.Z_PK>? ORDER BY m.Z_PK ASC LIMIT 5", [r.conversation, ref.id]);
      neighbors = [...previous, ...following].map(row => record(source, row));
    }
    return { record: r, context: neighbors.map(({ body, ...r }) => ({ ...r, excerpt: body.slice(0, 500) })) };
  } finally { await snap.close(); }
}

// Maintenance-only enumeration: one consistent SQLite snapshot, no query/top-N truncation.
export async function allDatabaseRecords(config:Config,source:"whatsapp"|"calls"){
 const snap=await createSnapshot(path(config,source));
 try{schema(snap.database,source);return rows(snap.database,source,"",[]).map(r=>record(source,r));}finally{await snap.close();}
}
