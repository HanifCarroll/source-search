import type { Database } from "bun:sqlite";
import { fail, now, queryKey, position, cursor } from "./identity";
import { hit, within } from "./results";
import { type Query, type RecordData, type Page, type Hit } from "./contracts";
import { findRecordMatch } from "./content";
// Keyset order uses source time plus ID, so adding newer records does not shift a continuation.
export function scanRecords(db: Database, select: string, conditions: string[], values: any[], time: string, id: string, q: Query, convert: (row: any) => RecordData, groupKey?:(record:RecordData)=>string|undefined): Page {
    const key = queryKey(q), ascending = q.sort === "oldest", token = position(q.cursor, key);
    let bound: any[] | undefined;
    if (token !== undefined) {
        try {
            bound = JSON.parse(String(token));
            if (!Array.isArray(bound) || bound.length !== 2 || typeof bound[0] !== "string" || !/^[-]?\d+(?:\.\d+)?$/.test(bound[0]) || bound[0].length > 40 || !Number.isSafeInteger(bound[1]))
                throw Error();
        }
        catch {
            fail("INVALID_CURSOR", "Invalid source date/ID continuation; restart the search");
        }
    }
    const order = `coalesce(${time},-9007199254740991)`;
    if (bound) {
        conditions.push(`(${order},${id}) ${ascending ? ">" : "<"} (?,?)`);
        values.push(bound[0].includes(".") ? Number(bound[0]) : BigInt(bound[0]), bound[1]);
    }
    const direction = ascending ? "ASC" : "DESC";
    const split = select.lastIndexOf(" FROM ");
    if (split < 0)
        fail("INVALID_REQUEST", "Source scan lacks its fixed table selection");
    const sql = select.slice(0, split) + `,${order} sortTime` + select.slice(split);
    const rows = db.query(`${sql} WHERE ${conditions.length ? conditions.join(" AND ") : "1=1"} ORDER BY ${order} ${direction},${id} ${direction} LIMIT 5001`).all(...values) as any[];
    const items:Hit[] = [];
    let scanned = 0, last = token;
    const warnings: string[] = [];
    let undecodable=0,missingText=0,stopped=false;let firstDate:string|undefined,lastDate:string|undefined,previousGroup:string|undefined;
    for (const row of rows.slice(0, 5000)) {
        scanned++;
        const r = convert(row); firstDate ||= r.occurredAt; lastDate=r.occurredAt;
        if(r.metadata?.bodyStatus === "text-unavailable")missingText++;
        const numericId = Number(row.rowid ?? row.pk ?? row.id);
        if (!Number.isSafeInteger(numericId))
            fail("UNSUPPORTED_SCHEMA", "Native ID exceeds its safe range");
        const after=JSON.stringify([String(row.sortTime), numericId]),matches=within(r.occurredAt,q) && findRecordMatch(r,q),group=groupKey?.(r),previous=items.at(-1);
        const visits=(previous?.metadata?.relatedVisits || []) as {ref:RecordData["ref"];occurredAt?:string;url?:unknown}[];
        const merge=matches && group && group===previousGroup && previous && visits.length<24 && r.occurredAt && previous.occurredAt && Math.abs(Date.parse(r.occurredAt)-Date.parse(previous.occurredAt))<=60_000;
        // Group only consecutive nearby matches; every visit remains readable and the cursor consumes no unreturned group.
        if(matches && !merge && items.length===q.limit){stopped=true;break;}
        last=after;
        if(merge){visits.push({ref:r.ref,occurredAt:r.occurredAt,url:r.metadata?.url});previous.metadata={...previous.metadata,relatedVisits:visits};previous.cursorAfter=cursor(key,after);}
        else if(matches){items.push(hit(r,q,after));previousGroup=group;}
        if (r.warnings?.some(w => /could not be decoded|undecodable/i.test(w))) { undecodable++;
            warnings.push("Some candidate text could not be decoded; coverage is incomplete"); }
        if (items.length === q.limit && !groupKey)
            break;
    }
    const more = stopped || scanned < rows.length;
    if (more && scanned === 5000)
        warnings.push("Work limit reached; continue with nextCursor even if this page has no matches");
    if(missingText)warnings.push(`${missingText} checked local entries have no searchable message text or supported caption in this store.`);
    return { source: q.source, status: warnings.length ? "partial" : "ok", items, scan:{checked:scanned,undecodable,...(missingText ? {missingText} : {}),exhausted:!more,dateSpan:{from:ascending?firstDate:lastDate,to:ascending?lastDate:firstDate},...(more && scanned===5000 ? {workLimit:"5000 candidates"} : {})}, ...(more ? { nextCursor: cursor(key, last!) } : {}), warnings: [...new Set(warnings)], observedAt: now() };
}
