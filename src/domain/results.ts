import type { Query, RecordData, Hit } from "./contracts";
import { fail, hash, queryKey, cursor, numberPosition } from "./identity";
import { matchesQuery } from "./query";
import { contentSections, findRecordMatch, focusedOffset, focusToken } from "./content";
import { compactRecord } from "./presentation";
export function matches(text: string, query: string) { return matchesQuery(text,{query}); }
export function within(date: string | undefined, q: Query) {
  if (!q.from && !q.to) return true;
  if (!date || !Number.isFinite(Date.parse(date))) return false;
  const n = Date.parse(date); return (!q.from || n >= Date.parse(q.from)) && (!q.to || n < Date.parse(q.to));
}
export function hit(record: RecordData, q: Query, after: string | number): Hit {
  const compact = compactRecord(record);
  const providerSyntax=(q.source.startsWith("mail-") || q.source === "agent-history") && !q.match && /[:(){}]/.test(q.query);
  const match = (!providerSyntax && (findRecordMatch(compact,q) || (record.type === "email" ? findRecordMatch(compact,{...q,sections:["metadata"]}) : undefined))) || {field:"provider" as const,explanation:providerSyntax ? "Provider query matched this record; native operators may match headers or labels rather than a body passage." : "Provider matched this record; read its original to locate the passage."};
  if(q.sections?.includes("metadata") && compact.body!==record.body && findRecordMatch(record,q)?.section === "metadata")Object.assign(match,{field:"body",section:"metadata",explanation:"Matched export metadata; use details:true to inspect the original fields"});
  if(compact.metadata?.previewOnly){delete match.start;delete match.end;delete match.section;match.explanation="Matched a provider preview; the original passage and section need a record read";}
  const { body, sections, metadata, locator, observedAt, ...info } = compact;
  if(match.explanation===`Matched ${match.section} text`)delete match.explanation;
  const keys = ["dateKind","authorship","reshared","replyTo","direction","senderId","senderIdentity","openLink","openAction","messageId","muesliMeetingId","historical","datePrecision","timezone","group","bodyStatus","attachments","profileName","url","downloadsAreMetadataOnly","folders","selectedBranch","nodeId","contentType","category","relatedResource"];
  const brief = Object.fromEntries(Object.entries(metadata || {}).filter(([k,v])=>keys.includes(k) && !(k === "url" && v === metadata?.openLink)));
  const start = match.start === undefined ? 0 : Math.max(0,match.start - 100);
  const primary=record.ref.source==="linkedin-archive" && !q.sections?.includes("metadata") ? contentSections(compact).filter(s=>s.kind==="primary" && body.slice(s.start,s.end).trim()) : [];
  const passage=primary.find(s=>match.start!==undefined && s.start<=match.start && match.start<s.end);
  const snippet = passage ? body.slice(Math.max(passage.start,start),Math.min(passage.end,Math.max(passage.start,start)+240)) : primary.length ? primary.map(s=>body.slice(s.start,s.end)).join(" · ").slice(0,240) : record.ref.source==="linkedin-archive" && compact.metadata?.bodyStatus && compact.metadata.bodyStatus!=="text" ? String(compact.metadata.bodyStatus==="attachment-only" ? "Attachment-only message; file contents are not indexed." : "No exported message text.") : match.field === "title" ? compact.title.slice(0,240) : body.slice(start,start+240);
  // The page carries observation time; an original read returns full provenance instead of duplicating a known opening link here.
  return { ...info,...(!brief.openLink ? {locator} : {}), metadata:brief, title:info.title.slice(0,160), author:info.author?.slice(0,160), excerpt:snippet, match, ...(match.field === "body" && match.start !== undefined ? {focus:focusToken(compact,match)} : {}), cursorAfter:cursor(queryKey(q),after) };
}
export function textPage(record: RecordData, token?: string, focus?: string) {
  if (token && focus) fail("INVALID_REQUEST","Choose a continuation or a focused read, not both");
  const key = hash(JSON.stringify(record.ref) + hash(record.body));
  let offset = focus ? focusedOffset(record,focus) : numberPosition(token,key);
  if(offset>0 && record.body.charCodeAt(offset)>=0xdc00 && record.body.charCodeAt(offset)<=0xdfff)offset--;
  if (offset > record.body.length) fail("INVALID_CURSOR", "Record offset is beyond the content");
  let body = record.body.slice(offset, offset + 10_000); // Leaves room for UTF-8 expansion and context in the packet.
  const last = body.charCodeAt(body.length - 1);
  if (last >= 0xd800 && last <= 0xdbff && offset + body.length < record.body.length) body = body.slice(0, -1);
  const { metadata, warnings, sections, ...base } = record;
  return { ...base, ...(!token ? {metadata,warnings} : {}), page: {offset,end:offset+body.length,totalCharacters:record.body.length,...(focus ? {focused:true,omittedBefore:offset>0,omittedAfter:offset+body.length<record.body.length} : {})}, body, nextCursor: offset + body.length < record.body.length ? cursor(key, offset + body.length) : undefined, truncated: offset + body.length < record.body.length };
}
export function packetBytes(value: unknown) {
  const json=JSON.stringify(value);
  return Buffer.byteLength((value as any)?.content ? json : JSON.stringify({content:[{type:"text",text:json}]}));
}
export function assertPacket(value: unknown) {
  if (packetBytes(value) > 48 * 1024) fail("OUTPUT_LIMIT", "Response exceeds the packet budget; request less context");
}
