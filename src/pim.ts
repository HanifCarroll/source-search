import type { Config } from "./config";
import { runLocalCass } from "./vendor/cass/runner";
import { fail, now, querySchema, queryKey,position,cursor, stableJson, versioned, assertVersion, type Query, type Ref, type RecordData } from "./shared";
import { recordPage } from "./pages";
import { readableHtml } from "./vendor/takeout/parsers";

export async function helper(config: Config, args: string[]) {
  if (!["status", "calendar", "contacts"].includes(args[0])) fail("INVALID_REQUEST", "Only native read commands are available");
  const r = await runLocalCass({ binaryPath: config.pimLauncher, args: [config.pimHelper, ...args], timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
  if (r.timedOut) fail("TIMEOUT", "Native source helper timed out");
  if (r.outputLimitExceeded) fail("SOURCE_LIMIT", "Native source helper exceeded its output budget; use a smaller calendar window");
  const records = r.stdout.split("\n").filter(Boolean).map(s => JSON.parse(s));
  const error = records.find(r => r.type === "error");
  if (error && /authorization/.test(error.code)) fail("PERMISSION_DENIED", `Native ${error.source} read access is ${error.authorization}`);
  if (r.exitCode !== 0 && !records.some(r => r.type === "scan_finished")) fail("SOURCE_UNAVAILABLE", "Native helper could not complete the read");
  return records;
}
export async function pimStatus(config: Config, source: "calendar" | "contacts") {
  const records = await helper(config, ["status"]), status = records.find(r => r.type === "status");
  if (!status || status[source + "Authorization"] !== "authorized") fail("PERMISSION_DENIED", `Native ${source} read access is ${status?.[source + "Authorization"] || "unknown"}`);
  return { authorization: "authorized", coverage: source === "calendar" ? "All calendars visible through EventKit in the requested date window" : "All contacts visible through the existing authorized Contacts identity" };
}
function window(input: Query) {
  const q = querySchema.parse(input);
  if (!q.from || !q.to) fail("REQUIRED_FILTER", "Calendar search requires from and to timestamps");
  if (Date.parse(q.to) - Date.parse(q.from) > 366 * 86400_000) fail("SOURCE_LIMIT", "Calendar windows must be at most 366 days; query additional windows separately");
  return { from: q.from, to: q.to };
}
async function records(config: Config, source: "calendar" | "contacts", range?: { from: string; to: string }) {
  const data = await helper(config, source === "contacts" ? ["contacts", "--max-records", "10000", "--max-output-bytes", "4000000"] : ["calendar", "--from", range!.from, "--to", range!.to, "--max-records", "10000", "--max-output-bytes", "4000000"]);
  const native = data.filter(r => r.type === (source === "calendar" ? "calendar_event" : "contact"));
  const footer = data.find(r => r.type === "scan_finished" && r.source === source);
  const warnings = data.filter(r => r.type === "warning" || r.type === "error").map(r => String(r.message));
  if (!footer || footer.complete !== true || footer.scanned !== native.length) warnings.push("Native scan is incomplete; narrow the date window or inspect source access");
  const out = native.map((raw): RecordData => {
    if (source === "contacts") raw.id = raw.identifier;
    if (source === "calendar") {
      // EventKit returns attendees in arbitrary order and recurrence descriptions contain process addresses.
      raw.attendees = raw.attendees?.sort((a: unknown, b: unknown) => stableJson(a).localeCompare(stableJson(b)));
      raw.recurrence = raw.recurrence?.map((s: string) => s.replace(/0x[0-9a-f]+/gi, "<instance>"));
    }
    if (typeof raw.id !== "string" || !raw.id) fail("UNSUPPORTED_SCHEMA", "Native record lacks an identifier");
    const identity = source === "calendar" ? [raw.id, raw.start, raw.calendar?.identifier, range] : raw.id;
    return versioned({ ref: { source, id: Buffer.from(JSON.stringify(identity)).toString("base64url") }, title: raw.title || raw.displayName || [raw.names?.given, raw.names?.family].filter(Boolean).join(" ") || "(Unnamed contact)", body: readablePim(source,raw), type: source === "calendar" ? "calendar-event" : "contact", locator: `source-search://${source}/${encodeURIComponent(raw.id)}`, occurredAt: source === "calendar" ? raw.start : undefined, observedAt: now(), metadata: source === "calendar" ? { originalContent:raw, calendar: raw.calendar, endedAt: raw.end, dateWindow: range, allDay: raw.allDay } : { originalContent:raw, identity: "Source-specific contact; possible matches are not merged" } });
  });
  if (new Set(out.map(r => r.ref.id)).size !== out.length) fail("UNSUPPORTED_SCHEMA", "Native helper returned duplicate record identities");
  return { records: out, warnings };
}
export async function searchPim(config: Config, q: Query) {
  if(q.conversation)fail("UNSUPPORTED_FILTER","Calendar and Contacts do not support conversation filters");
  if(q.source === "contacts"){
    if(q.from || q.to)fail("UNSUPPORTED_FILTER","Contacts have no reliable occurrence-date filter");
    const result=await records(config,"contacts");return recordPage(result.records,q,result.warnings,false);
  }
  if(!q.from || !q.to)fail("REQUIRED_FILTER","Calendar search requires from and to timestamps; multi-year ranges continue in bounded windows");
  const from=Date.parse(q.from),to=Date.parse(q.to),width=366*86400_000,count=Math.ceil((to-from)/width),key=queryKey(q);
  let state:{v:number;window:number;cursor?:string}={v:1,window:0};
  const token=position(q.cursor,key);
  if(token!==undefined){try{state=JSON.parse(String(token));if(state.v!==1 || !Number.isSafeInteger(state.window) || state.window<0 || state.window>=count || state.cursor!==undefined && typeof state.cursor!=="string")throw Error();}catch{fail("INVALID_CURSOR","Invalid calendar-window continuation; restart this search");}}
  const newest=q.sort === "newest" || !q.sort;
  const start=newest ? Math.max(from,to-(state.window+1)*width) : from+state.window*width;
  const end=newest ? to-state.window*width : Math.min(to,start+width);
  const range={from:new Date(start).toISOString(),to:new Date(end).toISOString()},result=await records(config,"calendar",range);
  // EventKit includes overlapping events; only their first traversed window emits each occurrence.
  const occurrences=result.records.filter(r=>{const time=Date.parse(r.occurredAt || "");return state.window===0 || (newest ? Date.parse(String(r.metadata?.endedAt || r.occurredAt))<=end : time>=start);});
  const page=recordPage(occurrences,{...q,...range,cursor:state.cursor},result.warnings,false);
  const wrap=(inner:string)=>cursor(key,JSON.stringify({...state,cursor:inner}));
  for(const item of page.items)item.cursorAfter=wrap(item.cursorAfter);
  page.nextCursor=page.nextCursor ? wrap(page.nextCursor) : state.window+1<count ? cursor(key,JSON.stringify({v:1,window:state.window+1})) : undefined;
  page.sourceWarnings=[`Calendar range is paged by date window; searched ${range.from} to ${range.to}. Ordering is within each window.`,...result.warnings];
  page.query={sort:q.sort || "newest",dateWindow:range};
  if(page.scan)page.scan.exhausted=!page.nextCursor && !result.warnings.length;
  return page;
}
export async function readPim(config: Config, ref: Ref) {
  let identity: any;
  try { identity = JSON.parse(Buffer.from(ref.id, "base64url").toString()); } catch { fail("INVALID_REFERENCE", "Invalid native record reference"); }
  let range;
  if (ref.source === "calendar") {
    if (!Array.isArray(identity) || identity.length !== 4 || identity.slice(0, 3).some(x => typeof x !== "string")) fail("INVALID_REFERENCE", "Invalid calendar occurrence identity");
    const q = { source: "calendar" as const, query: "", limit: 1, from: identity[3]?.from, to: identity[3]?.to }; range = window(q);
  } else if (typeof identity !== "string") fail("INVALID_REFERENCE", "Invalid contact identity");
  const r = (await records(config, ref.source as "calendar" | "contacts", range)).records.find(r => r.ref.id === ref.id);
  if (!r) fail("RECORD_NOT_FOUND", "Native record is absent from the current source window");
  assertVersion(ref, r.ref.version!); return r;
}

export function readablePim(source:string,r:any) {
  if(source === "calendar")return [r.title,r.start && `Start: ${r.start}`,r.end && `End: ${r.end}`,r.location && `Location: ${r.location}`,r.calendar?.title && `Calendar: ${r.calendar.title}`,r.attendees?.length && `Attendees: ${r.attendees.map((a:any)=>a.name || a.url || a.email || "Unknown").join(", ")}`,r.recurrence?.length && `Recurrence: ${r.recurrence.join("; ")}`,r.url && `URL: ${r.url}`,r.notes && readableHtml(r.notes)].filter(Boolean).join("\n\n");
  return [r.displayName || [r.names?.given,r.names?.family].filter(Boolean).join(" "),r.organization?.name || r.organization?.organization,...(r.emails||[]).map((v:any)=>`Email: ${typeof v === "string" ? v : v.value}`),...(r.phones||[]).map((v:any)=>`Phone: ${typeof v === "string" ? v : v.value}`),...(r.urls||[]).map((v:any)=>`URL: ${typeof v === "string" ? v : v.value}`),...(r.addresses||[]).map((v:any)=>`Address: ${typeof v === "string" ? v : [v.street,v.subLocality,v.city,v.state,v.postalCode,v.country].filter(Boolean).join(", ")}`)].filter(Boolean).join("\n");
}
