import { scanRecords } from "../../domain/scan";
import { matchesQuery } from "../../domain/query";
import { basename } from "node:path";
import type { Config } from "../../platform/config";
import { createSnapshot } from "../messages/reader";
import { requireColumns } from "./databases";
import { recordPage } from "../../domain/pages";
import { googleDocument } from "../../domain/presentation";
import { fail, now, versioned, assertVersion, queryKey, position, cursor } from "../../domain/identity";
import { contained, textFile } from "../../platform/source-files";
import { hit, matches, within } from "../../domain/results";
import { type RecordData, type Query, type Ref, type Page } from "../../domain/contracts";

const stamp = (v: number | bigint) => { const n = Number(v) / 1000 - 11644473600000; return Number.isFinite(n) && n > -8640000000000000 && n < 8640000000000000 ? new Date(n).toISOString() : undefined; };
function record(source: Query["source"], profile: string, index: number, row: any): RecordData {
  const identity = [index, String(row.id)],download=source === "chrome-downloads";
  let title=row.title || (row.target_path ? basename(row.target_path) : row.url) || "Chrome record",url=row.url || "";
  if(download)try{const u=new URL(url);if(u.hostname === "chatgpt.com" && u.pathname === "/backend-api/estuary/content" && /\.zip$/i.test(title))title="ChatGPT data export (ZIP)";url=u.origin+u.pathname;}catch{url="";}
  return versioned({ ref: { source, id: Buffer.from(JSON.stringify(identity)).toString("base64url") }, title, body: [title,url,download && row.target_path ? `Local file: ${row.target_path}` : ""].filter(Boolean).join("\n"), type: source.replace("chrome-", "browser-"), locator: `source-search://${source}/${index}/${row.id}`, occurredAt: stamp(row.time), observedAt: now(), metadata: { profile, profileName: basename(profile), url: row.url, downloadPath: row.target_path, downloadsAreMetadataOnly: download } });
}
async function bookmarks(config: Config) {
  const records: RecordData[] = [], warnings: string[] = [];
  for (let index = 0; index < config.chromeProfiles.length; index++) {
    const profile = config.chromeProfiles[index];
    try {
      const data = JSON.parse(await textFile(await contained(profile, "Bookmarks"), 8 * 1024 * 1024)); let count = 0;
      function walk(node: any, depth: number) {
        if (++count > 50_000 || depth > 64) fail("SOURCE_LIMIT", "Chrome bookmark tree exceeds its work budget");
        if (!node || typeof node !== "object") fail("UNSUPPORTED_SCHEMA", "Invalid bookmark node");
        if (node.type === "url") {
          if (typeof node.id !== "string" || typeof node.url !== "string") fail("UNSUPPORTED_SCHEMA", "Bookmark lacks native ID or URL");
          records.push(record("chrome-bookmarks", profile, index, { id: node.id, title: node.name, url: node.url, time: Number(node.date_added) }));
        }
        if (node.children !== undefined) { if (!Array.isArray(node.children)) fail("UNSUPPORTED_SCHEMA", "Invalid bookmark children"); for (const child of node.children) walk(child, depth + 1); }
      }
      if (!data.roots || typeof data.roots !== "object") fail("UNSUPPORTED_SCHEMA", "Chrome bookmarks lack roots");
      for (const root of Object.values(data.roots)) walk(root, 0);
    } catch { warnings.push(`Bookmarks unavailable in selected profile ${basename(profile)}`); }
  }
  if (warnings.length === config.chromeProfiles.length) fail("SOURCE_UNAVAILABLE", "No selected Chrome bookmarks source is readable");
  return { records, warnings };
}
function sql(source: Query["source"]) {
  return source === "chrome-history" ? "SELECT v.id,u.title,u.url,v.visit_time time FROM visits v JOIN urls u ON u.id=v.url WHERE v.id<? ORDER BY v.id DESC LIMIT ?" : "SELECT d.id,d.target_path,d.start_time time,(SELECT url FROM downloads_url_chains c WHERE c.id=d.id ORDER BY c.chain_index DESC LIMIT 1) url FROM downloads d WHERE d.id<? ORDER BY d.id DESC LIMIT ?";
}
function schema(db: any, source: Query["source"]) {
  if (source === "chrome-history") { requireColumns(db, "visits", ["id", "url", "visit_time"]); requireColumns(db, "urls", ["id", "title", "url"]); }
  else { requireColumns(db, "downloads", ["id", "start_time", "target_path"]); requireColumns(db, "downloads_url_chains", ["id", "url", "chain_index"]); }
}
export async function chromeStatus(config: Config, source: Query["source"]) {
  if (!config.chromeProfiles.length) fail("SOURCE_NOT_CONFIGURED", "Select Chrome profile roots first");
  if (source === "chrome-bookmarks") { const r = await bookmarks(config); return { records: r.records.length, profiles: config.chromeProfiles.map(p => basename(p)), warnings: r.warnings }; }
  const profiles = [], warnings = [];
  for (const profile of config.chromeProfiles) {
    try { const snap = await createSnapshot(await contained(profile, "History")); try { schema(snap.database, source); profiles.push(basename(profile)); } finally { await snap.close(); } }
    catch { warnings.push(`History store unavailable in selected profile ${basename(profile)}`); }
  }
  if (!profiles.length) fail("SOURCE_UNAVAILABLE", "No selected Chrome History database is readable");
  return { profiles, warnings, coverage: "Only configured profiles and locally retained history; URLs and downloads are not opened" };
}
export async function searchChrome(config: Config, q: Query): Promise<Page> {
  if (!config.chromeProfiles.length) fail("SOURCE_NOT_CONFIGURED", "Select Chrome profile roots first");
  if (q.conversation) fail("UNSUPPORTED_FILTER", "Chrome has no conversation filter");
  if (q.source === "chrome-bookmarks") { const r = await bookmarks(config); return recordPage(r.records, q, r.warnings); }
  const key=queryKey(q), raw=position(q.cursor,key);let state:{profile:number;cursor?:string}={profile:0};
  if(raw!==undefined){try{state=JSON.parse(String(raw));if(!Number.isSafeInteger(state.profile)||state.profile<0||state.profile>=config.chromeProfiles.length||state.cursor!==undefined&&typeof state.cursor!=="string")throw Error();}catch{fail("INVALID_CURSOR","Invalid Chrome profile continuation");}}
  const profile=config.chromeProfiles[state.profile],snap=await createSnapshot(await contained(profile,"History"));
  try {
    schema(snap.database,q.source);const history=q.source === "chrome-history";
    const select=history ? "SELECT v.id,u.title,u.url,v.visit_time time FROM visits v JOIN urls u ON u.id=v.url" : "SELECT d.id,d.target_path,d.start_time time,(SELECT url FROM downloads_url_chains c WHERE c.id=d.id ORDER BY c.chain_index DESC LIMIT 1) url FROM downloads d";
    const page=scanRecords(snap.database,select,[],[],history?"v.visit_time":"d.start_time",history?"v.id":"d.id",{...q,cursor:state.cursor},row=>record(q.source,profile,state.profile,row),history ? r=>googleDocument(r.metadata?.url)?.url : undefined);
    for(const item of page.items)item.cursorAfter=cursor(key,JSON.stringify({profile:state.profile,cursor:item.cursorAfter}));
    if(page.nextCursor)page.nextCursor=cursor(key,JSON.stringify({profile:state.profile,cursor:page.nextCursor}));
    else if(state.profile+1<config.chromeProfiles.length)page.nextCursor=cursor(key,JSON.stringify({profile:state.profile+1}));
    page.sourceWarnings=["Only configured profiles and retained metadata; ordering is per profile."];return page;
  } finally {await snap.close();}
}

export async function readChrome(config: Config, ref: Ref) {
  let id: any;
  try { id = JSON.parse(Buffer.from(ref.id, "base64url").toString()); if (!Array.isArray(id) || id.length !== 2 || !Number.isSafeInteger(id[0]) || id[0] < 0 || id[0] >= config.chromeProfiles.length || typeof id[1] !== "string") throw Error(); } catch { fail("INVALID_REFERENCE", "Invalid selected-profile Chrome reference"); }
  let r: RecordData | undefined;
  if (ref.source === "chrome-bookmarks") r = (await bookmarks(config)).records.find(r => r.ref.id === ref.id);
  else {
    if (!/^\d+$/.test(id[1])) fail("INVALID_REFERENCE", "Invalid Chrome row identifier");
    const snap = await createSnapshot(await contained(config.chromeProfiles[id[0]], "History"));
    try { schema(snap.database, ref.source); const select = sql(ref.source).replace(/WHERE (v|d).id<\? ORDER BY.*$/, "WHERE $1.id=?"); const row = snap.database.query(select).get(id[1]); if (row) r = record(ref.source, config.chromeProfiles[id[0]], id[0], row); } finally { await snap.close(); }
  }
  if (!r) fail("RECORD_NOT_FOUND", "Chrome record is absent from the current selected profile");
  assertVersion(ref, r.ref.version!); return r;
}
