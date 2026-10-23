import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { matchesQuery } from "./query";
import { contentSections, findRecordMatch, focusedOffset, focusToken } from "./content";
import { compactRecord } from "./presentation";

export const sourceIds = ["mail-personal", "mail-consulting", "mail-fastmail", "messages", "journals", "things-archive", "whatsapp", "voice-journals", "calls", "call-notes", "calendar", "contacts", "chrome-history", "chrome-bookmarks", "chrome-downloads", "chatgpt-archive", "takeout-archive", "linkedin-archive", "twitter-archive", "agent-history", "vault", "library", "documents"] as const;
export const sourceId = z.enum(sourceIds);
export const sectionKind = z.enum(["primary", "quoted", "generated", "manual", "review", "metadata"]);
export type SectionKind = z.infer<typeof sectionKind>;
export type TextSection = { kind: SectionKind; start: number; end: number };
export type MatchInfo = { field: "body" | "title" | "provider" | "browse"; section?: SectionKind; start?: number; end?: number; explanation?: string };
export const querySchema = z.object({
  source: sourceId, query: z.string().max(1000),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  conversation: z.string().min(1).max(500).optional(), cursor: z.string().max(8192).optional(),
  mode: z.enum(["lexical", "semantic", "hybrid"]).optional(),
  match: z.enum(["words", "phrase"]).optional(),
  sections: z.array(sectionKind).min(1).max(6).optional(),
  sort: z.enum(["relevance", "newest", "oldest"]).optional(),
  types: z.array(z.string().min(1).max(100)).max(20).optional(),
  roles: z.array(z.string().min(1).max(100)).max(10).optional(),
  contentTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
  selectedBranch: z.boolean().optional(),
  folders: z.array(z.string().min(1).max(200)).max(20).optional(),
  excludeSpamTrash: z.boolean().optional(),
  limit: z.number().int().min(1).max(25).default(10)
}).strict().refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), "from must precede to");
export const selectionSchema = z.object({...querySchema.shape,source:z.enum([...sourceIds,"all-journals","all-mail","historical-exports"])}).strict().refine(q=>!q.from || !q.to || Date.parse(q.from)<Date.parse(q.to),"from must precede to");
export const searchSchema = z.object({ queries: z.array(selectionSchema).min(1).max(sourceIds.length) }).strict()
  .refine(r => new Set(r.queries.map(q => q.source)).size === r.queries.length, "Search each source at most once per request");
export const refSchema = z.object({ source: sourceId, id: z.string().min(1).max(16000), version: z.string().max(100).optional() }).strict();
export const readSchema = z.object({ ref: refSchema, cursor: z.string().max(4000).optional(), focus:z.string().max(1000).optional(), preview:z.boolean().default(false), context: z.boolean().default(false), details: z.boolean().default(false) }).strict();
export type Query = z.infer<typeof querySchema>;
export type Ref = z.infer<typeof refSchema>;
export type RecordData = {
  ref: Ref; title: string; body: string; type: string; locator: string;
  occurredAt?: string; observedAt: string; author?: string; conversation?: string;
  metadata?: Record<string, unknown>; warnings?: string[]; sections?: TextSection[];
};
export type Hit = Omit<RecordData, "body" | "locator" | "observedAt"> & { locator?:string; excerpt: string; cursorAfter: string; match: MatchInfo; focus?: string };
export type Page = { retrieval?: { requestedMode: string; effectiveMode: string | null; fallbackReason?: string | null }; source: Query["source"]; status: "ok" | "partial" | "error"; items: Hit[]; nextCursor?: string; warnings: string[]; error?: { code: string; message: string }; observedAt: string; totalMatches?: number; budgetReduced?:boolean; reduction?: { requested:number; returned:number; reason:string }; scan?: {checked:number; undecodable:number; missingText?:number; exhausted:boolean; dateSpan?: {from?:string;to?:string}; workLimit?:string}; progress?: { returned:number; hasMore:boolean; totalMatches:number|null; continuation:string }; query?: Record<string,unknown>; sourceWarnings?: string[] };
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
export function errorData(error: unknown) {
  const e = error as { code?: string; message?: string };
  return { code: e.code || "SOURCE_UNAVAILABLE", message: (e.message || "Source request failed").slice(0, 500) };
}
export const now = () => new Date().toISOString();
export function stableJson(value: unknown, space?: number): string { return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v, space); }
export function recordVersion(record: RecordData) { return hash(stableJson({ title: record.title, type: record.type, body: record.body, author: record.author, occurredAt: record.occurredAt, conversation: record.conversation, metadata: record.metadata })); }
export function versioned(record: RecordData) { record.ref.version = recordVersion(record); return record; }
export function queryKey(q: Query) { const { cursor, limit, ...identity } = q; return hash(JSON.stringify({...identity,...(q.source.startsWith("mail-") || q.source === "takeout-archive" ? {excludeSpamTrash:q.excludeSpamTrash!==false} : {})})); }
export function cursor(key: string, position: string | number) { return Buffer.from(JSON.stringify({ key, position })).toString("base64url"); }
export function position(token: string | undefined, key: string): string | number | undefined {
  if (!token) return undefined;
  try {
    const v = JSON.parse(Buffer.from(token, "base64url").toString());
    if (v.key !== key || !["string", "number"].includes(typeof v.position)) throw Error();
    return v.position;
  } catch { return fail("INVALID_CURSOR", "Cursor does not belong to this query or record"); }
}
export function numberPosition(token: string | undefined, key: string, fallback = 0) {
  const n = position(token, key) ?? fallback;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) fail("INVALID_CURSOR", "Invalid cursor position");
  return n;
}
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
export async function regular(path: string) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink()) fail("UNSAFE_PATH", "Source must be a regular file, not a symbolic link");
  return st;
}
export async function contained(root: string, name: string) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("UNSAFE_PATH", "Source root must be an ordinary directory");
  if (isAbsolute(name)) fail("UNSAFE_PATH", "Expected a source-relative record ID");
  const target = resolve(root, name), rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) fail("UNSAFE_PATH", "Record is outside its source root");
  const actualRoot = await realpath(root), actual = await realpath(target);
  const actualRel = relative(actualRoot, actual);
  if (actualRel === ".." || actualRel.startsWith(".." + sep) || isAbsolute(actualRel)) fail("UNSAFE_PATH", "Record link escapes its source root");
  // Reject symlinked directories too, including links that happen to stay inside the root.
  let path = resolve(root);
  for (const part of rel.split(sep)) { path = resolve(path, part); if ((await lstat(path)).isSymbolicLink()) fail("UNSAFE_PATH", "Source links are not followed"); }
  await regular(target); return target;
}
export async function textFile(path: string, maxBytes = 2 * 1024 * 1024) {
  const st = await regular(path); if (st.size > maxBytes) fail("SOURCE_LIMIT", "Source file exceeds the read budget");
  const data = await readFile(path);
  if (data.length > maxBytes) fail("SOURCE_LIMIT", "Source grew beyond the read budget");
  return data.toString("utf8");
}
export function assertVersion(ref: Ref, version: string) { if (ref.version && ref.version !== version) fail("STALE_RECORD", "Original changed; search again for its current reference"); }
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
