import { scanRecords } from "../../domain/scan";
import { createSnapshot } from "../../platform/sqlite";
import { decodeAttributedBody, messagesTimestampToIso } from "./reader";
import type { Config } from "../../platform/config";
import { fail, hash, now, assertVersion } from "../../domain/identity";
import { type Query, type Page, type RecordData, type Ref } from "../../domain/contracts";
import type { Database } from "bun:sqlite";

function columns(db: Database, table: string) { return new Set((db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(c => c.name.toLowerCase())); }
function schema(db: Database) {
  const message = columns(db, "message"), chat = columns(db, "chat"), joins = columns(db, "chat_message_join"), handle = columns(db, "handle");
  if (!["guid", "date", "is_from_me"].every(c => message.has(c)) || !chat.has("guid") || !joins.has("chat_id") || !joins.has("message_id") || (!message.has("text") && !message.has("attributedbody"))) fail("UNSUPPORTED_SCHEMA", "Messages schema lacks required content or conversation columns");
  const select = (name: string) => message.has(name.toLowerCase()) ? `m."${name}"` : "NULL";
  return { select, handle: handle.has("id") && message.has("handle_id") };
}
function queryRows(db: Database, suffix: string, values: (string | number)[]) {
  const s = schema(db);
  const sql = `SELECT m.ROWID rowid,m.guid,m.date,m.is_from_me,${s.select("text")} text,${s.select("attributedBody")} attributedBody,${s.select("service")} service,${s.select("cache_has_attachments")} attachments,${s.select("item_type")} itemType,${s.handle ? "h.id" : "NULL"} sender FROM message m ${s.handle ? "LEFT JOIN handle h ON h.ROWID=m.handle_id" : ""} ${suffix}`;
  return db.query(sql).all(...values) as any[];
}
function record(db: Database, row: any): RecordData {
  const decoded = typeof row.text === "string" ? { text: row.text, status: "text" } : row.attributedBody ? decodeAttributedBody(row.attributedBody) : { text: "", status: "missing" };
  const body = decoded.text || "", id = row.guid || `row:${row.rowid}`;
  const chats = db.query("SELECT c.guid FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID WHERE j.message_id=? ORDER BY c.ROWID").all(row.rowid) as { guid: string }[];
  const outgoing = row.is_from_me === 1n, known = row.is_from_me === 1n || row.is_from_me === 0n;
  return { ref: { source: "messages", id, version: hash(JSON.stringify([body, String(row.date), String(row.is_from_me)])) }, title: body.slice(0, 120) || "(Message without readable text)", body, type: "message", locator: `source-search://messages/${encodeURIComponent(id)}`,
    occurredAt: messagesTimestampToIso(row.date), observedAt: now(), author: row.itemType ? "unknown (system item)" : known ? outgoing ? "self" : row.sender || "unknown sender" : "unknown direction",
    conversation: chats.length === 1 ? chats[0].guid : undefined,
    metadata: { chats: chats.map(c => c.guid), direction: known ? outgoing ? "outgoing" : "incoming" : "unknown", service: row.service, hasAttachments: !!row.attachments, bodyStatus: decoded.status },
    warnings: decoded.status === "undecodable" ? ["Binary body could not be decoded safely; content is not invented"] : [] };
}
export async function messagesStatus(config: Config) {
  const snap = await createSnapshot(config.messages);
  try { schema(snap.database); return { readable: true, snapshotAt: now(), originalModifiedAt: snap.sourceDatabaseModifiedAt }; }
  finally { await snap.close(); }
}
export async function searchMessages(config: Config, q: Query): Promise<Page> {
  const snap=await createSnapshot(config.messages);
  try {
    const s=schema(snap.database), conditions:string[]=[],values:any[]=[];
    if(q.conversation){conditions.push("EXISTS (SELECT 1 FROM chat_message_join j JOIN chat c ON c.ROWID=j.chat_id WHERE j.message_id=m.ROWID AND c.guid=?)");values.push(q.conversation);}
    const select=`SELECT m.ROWID rowid,m.guid,m.date,m.is_from_me,${s.select("text")} text,${s.select("attributedBody")} attributedBody,${s.select("service")} service,${s.select("cache_has_attachments")} attachments,${s.select("item_type")} itemType,${s.handle ? "h.id" : "NULL"} sender FROM message m ${s.handle ? "LEFT JOIN handle h ON h.ROWID=m.handle_id" : ""}`;
    const page=scanRecords(snap.database,select,conditions,values,"m.date","m.ROWID",q,row=>record(snap.database,row));
    page.sourceWarnings=["Local Mac Messages store; complete phone/iCloud history is not guaranteed."];return page;
  } finally {await snap.close();}
}

export async function readMessage(config: Config, ref: Ref, context: boolean) {
  const snap = await createSnapshot(config.messages);
  try {
    const numeric = /^row:(\d+)$/.exec(ref.id);
    if (numeric && !Number.isSafeInteger(Number(numeric[1]))) fail("INVALID_REFERENCE", "Message row ID exceeds the safe identifier range");
    const rows = queryRows(snap.database, numeric ? "WHERE m.ROWID=?" : "WHERE m.guid=?", [numeric ? Number(numeric[1]) : ref.id]);
    if (!rows.length) fail("RECORD_NOT_FOUND", "Message is absent from the current source snapshot");
    const r = record(snap.database, rows[0]); assertVersion(ref, r.ref.version!);
    let contextRecords: RecordData[] = [];
    if (context && r.conversation) {
      const condition = "EXISTS (SELECT 1 FROM chat_message_join j JOIN chat c ON c.ROWID=j.chat_id WHERE j.message_id=m.ROWID AND c.guid=?)";
      const previous = queryRows(snap.database, `WHERE ${condition} AND m.ROWID < ? ORDER BY m.ROWID DESC LIMIT 5`, [r.conversation, rows[0].rowid]).reverse();
      const following = queryRows(snap.database, `WHERE ${condition} AND m.ROWID > ? ORDER BY m.ROWID ASC LIMIT 5`, [r.conversation, rows[0].rowid]);
      contextRecords = [...previous, ...following].map(row => record(snap.database, row));
    }
    return { record: r, context: contextRecords.map(({ body, ...info }) => ({ ...info, excerpt: body.slice(0, 500) })) };
  } finally { await snap.close(); }
}

export async function allMessageRecords(config:Config){
 const snap=await createSnapshot(config.messages);
 try{return queryRows(snap.database,"ORDER BY m.ROWID",[]).map(r=>record(snap.database,r));}finally{await snap.close();}
}
