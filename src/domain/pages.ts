import { findRecordMatch } from "./content";
import { sortRecords, filterRecord } from "./query";
import { fail, now, queryKey, numberPosition, hash, cursor } from "./identity";
import { hit, within } from "./results";
import { type Query, type RecordData, type Page } from "./contracts";

export function recordPage(records: RecordData[], q: Query, warnings: string[] = [], filterDates = true): Page {
  records = sortRecords(records,q);
  const key = queryKey(q) + hash(JSON.stringify(records.map(r => r.ref))), start = numberPosition(q.cursor, key);
  if (start > records.length) fail("INVALID_CURSOR", "Cursor is beyond this source snapshot");
  const items = []; let offset = start, checked = 0;
  while (offset < records.length && items.length < q.limit && checked < 5000) {
    checked++;
    const r = records[offset++];
    if ((!filterDates || within(r.occurredAt, q)) && (!q.conversation || r.conversation === q.conversation) && filterRecord(r,q) && findRecordMatch(r,q)) {
      const h = hit(r, q, offset); h.cursorAfter = cursor(key, offset); items.push(h);
    }
  }
  if (offset < records.length && checked >= 5000) warnings = [...warnings, "Work limit reached; continue with nextCursor"];
  return { source: q.source, status: warnings.length ? "partial" : "ok", items, scan:{checked,undecodable:0,exhausted:offset>=records.length,...(checked>=5000 && offset<records.length ? {workLimit:"5000 candidates"} : {})}, ...(offset < records.length ? { nextCursor: cursor(key, offset) } : {}), warnings, observedAt: now() };
}
