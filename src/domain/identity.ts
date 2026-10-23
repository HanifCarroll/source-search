import { createHash } from "node:crypto";
import type { Query, Ref, RecordData } from "./contracts";
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
export function assertVersion(ref: Ref, version: string) { if (ref.version && ref.version !== version) fail("STALE_RECORD", "Original changed; search again for its current reference"); }
