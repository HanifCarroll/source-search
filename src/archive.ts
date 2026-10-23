import {privateDirectory,markManagedCache} from "./storage";
import { findRecordMatch, recordSearchText } from "./content";
import { linkedInFilterType } from "./linkedin";
import { words } from "./query";
import { Database } from "bun:sqlite";
import { mkdir, rename, rm, chmod, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sourceEnabled, requireMaintenance, type Config } from "./config";
import { archiveSignature, checkExportSelection, exportRecords, archiveSources, exportPaths, exportProjectionVersion, type ArchiveSource } from "./exports";
import { fail, regular, queryKey, numberPosition, cursor, hit, now, type Query, type Page, type RecordData } from "./shared";

export async function rebuildArchive(config: Config) {
  requireMaintenance(config);
  const archives = await Promise.all(archiveSources.filter(s => sourceEnabled(config,s) && exportPaths(config,s).length).map(async source => {const signature=await archiveSignature(config,source),result=await exportRecords(config,source);if(signature!==await archiveSignature(config,source))fail("STALE_RECORD","Original archive changed during rebuild; old index retained");return {source,...result,signature};}));
  const { generation, info } = archives[0] || {generation:"empty",info:{}};
  const total = archives.reduce((n, a) => n + a.records.size, 0);
  const directory = dirname(config.index); await markManagedCache(directory);await privateDirectory(directory);
  if ((await lstat(directory)).isSymbolicLink()) fail("UNSAFE_PATH", "Index directory cannot be a symbolic link");
  const path = config.index + "." + randomUUID() + ".sqlite";
  let db: Database | undefined;
  try {
    db = new Database(path, { create: true }); await chmod(path, 0o600);
    db.exec("CREATE TABLE records(source TEXT,id TEXT,data TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source,id)); CREATE VIRTUAL TABLE terms USING fts5(source UNINDEXED,id UNINDEXED, body); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    const insert = db.query("INSERT INTO records VALUES(?, ?, ?, ?)"), index = db.query("INSERT INTO terms VALUES(?, ?, ?)");
    db.transaction(() => {
      for (const a of archives) {
        for (const r of a.records.values()) { const { body, ...metadata } = r; insert.run(a.source, r.ref.id, JSON.stringify(metadata),body); index.run(a.source, r.ref.id, r.title + "\n" + recordSearchText(r)); }
        const records=[...a.records.values()], datedRecords=records.filter(r=>r.occurredAt && Number.isFinite(Date.parse(r.occurredAt))).length;
        db!.query("INSERT INTO meta VALUES(?,?)").run(a.source, JSON.stringify({ generation: a.generation, projectionVersion:exportProjectionVersion(a.source), count: a.records.size, dateCoverage:{datedRecords,undatedRecords:records.length-datedRecords}, recordTypes:[...new Set(records.map(r=>r.type))].sort(), categories:a.info.categories, ...(a.source === "chatgpt-archive" ? {conversations:a.info.conversations,roles:[...new Set(records.map(r=>r.author))].sort(),contentTypes:[...new Set(records.map(r=>r.metadata?.contentType))].sort()} : {}), warnings: a.warnings, signature:a.signature, indexedAt:now() }));
      }
      for (const [k, v] of Object.entries({ formatVersion:"2", generation, indexedAt: now(), exportedAt: info.exportedAt || "", count: String(total) })) db!.query("INSERT INTO meta VALUES(?,?)").run(k, v);
    })();
    db.exec("CREATE INDEX records_by_type ON records(source,json_extract(data,'$.type'))");
    if (Object.values(db.query("PRAGMA quick_check").get() as object)[0] !== "ok") fail("INDEX_INVALID", "New index failed its SQLite check");
    db.close(); db = undefined; await rename(path, config.index);
    return { indexedRecords: total, taskCount: info.taskCount, generation, index: config.index };
  } finally { db?.close(); await rm(path, { force: true }); }
}
export async function indexStatus(config: Config) {
  await regular(config.index); const db = new Database(config.index, { readonly: true });
  try {
    if (!(db.query("PRAGMA table_info(records)").all() as {name:string}[]).some(c => c.name === "source")) fail("INDEX_NOT_READY", "Rebuild the archive index explicitly for the expanded source catalogue");
    return Object.fromEntries((db.query("SELECT key,value FROM meta").all() as { key: string; value: string }[]).map(r => [r.key, r.value])); }
  finally { db.close(); }
}
export async function searchArchive(config: Config, q: Query): Promise<Page> {
  if (q.conversation && q.source !== "chatgpt-archive" && q.source !== "linkedin-archive" && q.source !== "twitter-archive") fail("UNSUPPORTED_FILTER", "This archive has no conversation filter");
  if (!exportPaths(config,q.source as ArchiveSource).length) fail("SOURCE_NOT_CONFIGURED", "Fresh export has not been downloaded and selected yet");
  await checkExportSelection(config, q.source as ArchiveSource);
  await indexStatus(config);
  await regular(config.index); const db = new Database(config.index, { readonly: true });
  try {
    const { indexedAt,formatVersion } = Object.fromEntries((db.query("SELECT key,value FROM meta").all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
    if(q.sections && formatVersion!=="2")fail("INDEX_FORMAT_UPGRADE","Section filters require an explicit source-search rebuild; ordinary queries remain supported");
    const entry = db.query("SELECT value FROM meta WHERE key=?").get(q.source) as { value: string } | null;
    if (!entry) fail("INDEX_NOT_READY", "Rebuild the disposable archive index for this selected source");
    const state = JSON.parse(entry.value);
    if(exportProjectionVersion(q.source as ArchiveSource)>1 && state.projectionVersion!==exportProjectionVersion(q.source as ArchiveSource))fail("INDEX_PROJECTION_UPGRADE","Updated export dates/formatting require an explicit source-search rebuild; original files are unchanged");
    if(state.signature && state.signature!==await archiveSignature(config,q.source as ArchiveSource))fail("INDEX_STALE","Selected export changed; run source-search rebuild explicitly before searching");
    const availableTypes=[...new Set<string>([...(state.recordTypes || []),...(state.categories || []).map((c:any)=>c.recordType).filter(Boolean)])];
    if(q.source==="linkedin-archive" && q.types)q={...q,types:[...new Set(q.types.map(t=>linkedInFilterType(t,state.categories || [])))]};
    const unavailable=q.types?.find(t=>!availableTypes.includes(t));
    if(unavailable)fail("TYPE_NOT_AVAILABLE",`Type '${unavailable}' is not available in the selected ${q.source} export. Use list_sources categories/recordTypes for supported values${q.source==="linkedin-archive" ? "; friendly names such as messages, posts and applications are accepted" : ""}. No export refresh is implied by this filter error.`);
    for(const [filter,available] of [[q.roles,state.roles],[q.contentTypes,state.contentTypes]] as [string[]|undefined,string[]|undefined][])if(filter?.some(v=>available && !available.includes(v)))fail("TYPE_NOT_AVAILABLE","Requested ChatGPT role/content type is absent from the selected export; use list_sources for available values");
    // Tie ordering is part of the cursor contract; older ordering tokens must restart.
    const key = queryKey(q) + state.generation + ":order-2", start = numberPosition(q.cursor,key);
    // Metadata is deliberately absent from FTS; explicit metadata scopes scan exact stored bodies in bounded batches.
    const terms = q.sections?.includes("metadata") ? "" : q.match === "phrase" ? (q.query.trim() ? '"'+q.query.replaceAll('"','""')+'"' : "") : words(q.query).map(t=>'"'+t+'"*').join(" AND ");
    const useTerms=!!terms || formatVersion!=="2";
    const clauses=[useTerms ? "t.source=?" : "r.source=?"], args:any[]=[q.source];
    if(terms){clauses.push("terms MATCH ?");args.push(terms);}
    if(q.conversation){clauses.push("json_extract(r.data,'$.conversation')=?");args.push(q.conversation);}
    if(q.types?.length){clauses.push("json_extract(r.data,'$.type') IN ("+q.types.map(()=>"?").join(",")+")");args.push(...q.types);}
    if(q.roles?.length){clauses.push("json_extract(r.data,'$.author') IN ("+q.roles.map(()=>"?").join(",")+")");args.push(...q.roles);}
    if(q.contentTypes?.length){clauses.push("json_extract(r.data,'$.metadata.contentType') IN ("+q.contentTypes.map(()=>"?").join(",")+")");args.push(...q.contentTypes);}
    if(q.selectedBranch !== undefined){clauses.push("json_extract(r.data,'$.metadata.selectedBranch')=?");args.push(Number(q.selectedBranch));}
    const join=useTerms ? "FROM terms t JOIN records r ON r.id=t.id AND r.source=t.source" : "FROM records r";
    const undated=q.from || q.to ? Number((db.query(`SELECT count(*) n ${join} WHERE ${clauses.join(" AND ")} AND julianday(json_extract(r.data,'$.occurredAt')) IS NULL`).get(...args) as {n:number}).n) : 0;
    if(q.from){clauses.push("(julianday(json_extract(r.data,'$.occurredAt')) >= julianday(?) OR (json_extract(r.data,'$.metadata.datePrecision') IN ('month','day') AND julianday(json_extract(r.data,'$.occurredAt'),CASE json_extract(r.data,'$.metadata.datePrecision') WHEN 'month' THEN '+1 month' ELSE '+1 day' END) > julianday(?)))");args.push(q.from,q.from);}
    if(q.to){clauses.push("julianday(json_extract(r.data,'$.occurredAt')) < julianday(?)");args.push(q.to);}
    if(q.source === "takeout-archive" && q.excludeSpamTrash!==false)clauses.push("NOT EXISTS (SELECT 1 FROM json_each(json_extract(r.data,'$.metadata.labels')) WHERE lower(value) IN ('spam','trash'))");
    const where=clauses.join(" AND ");
    const sort=q.sort === "relevance" && !terms ? "newest" : q.sort || (terms ? "relevance" : "newest");
    const sourceOrder=q.source==="linkedin-archive" ? "json_extract(data,'$.metadata.entry'),cast(json_extract(data,'$.metadata.row') AS INTEGER),id" : "id";
    const order=(sort === "relevance" && terms ? "relevance,id" : "json_extract(data,'$.occurredAt') IS NULL,julianday(json_extract(data,'$.occurredAt')) "+(sort === "oldest" ? "ASC" : "DESC")+","+sourceOrder);
    const cte=`WITH matching AS MATERIALIZED (SELECT r.data,${formatVersion === "2" ? "r.body" : "t.body"} body,r.id,${terms ? "rank" : "NULL"} relevance ${join} WHERE ${where})`;
    const total=Number((db.query(`${cte} SELECT count(*) n FROM matching`).get(...args) as {n:number}).n);
    if(start>total) fail("STALE_CURSOR","Archive results changed; restart without the cursor");
    const rows=db.query(`${cte} SELECT * FROM matching ORDER BY ${order} LIMIT 5000 OFFSET ?`).iterate(...args,start) as Iterable<{data:string;body:string}>;
    const items=[];let checked=0;
    for(const row of rows){
      checked++;const metadata=JSON.parse(row.data),r={...metadata,body:formatVersion === "2" ? row.body : row.body.slice(metadata.title.length+1)} as RecordData;
      if(!findRecordMatch(r,q))continue;
      const item=hit(r,q,start+checked);item.cursorAfter=cursor(key,start+checked);
      if(formatVersion!=="2"){delete item.focus;item.match.explanation="Legacy index preview; rebuild explicitly for precise original-text focus";}
      items.push(item);if(items.length>=q.limit)break;
    }
    const warnings=[...new Set(items.flatMap(r=>r.warnings || []))];
    const emptyCategories=q.types?.length ? (state.categories || []).filter((c:any)=>q.types!.includes(c.recordType)) : [];
    if(total===0 && emptyCategories?.length && emptyCategories.every((c:any)=>c.records===0))warnings.push("The selected categories contain no exported records. Changing keywords will not produce results.");
    else if(total===0 && undated)warnings.push("No records match this date window. Some records lack a supported date; omit from/to to include them.");
    const dated=Number((db.query(`SELECT count(*) n ${join} WHERE ${where} AND julianday(json_extract(r.data,'$.occurredAt')) IS NOT NULL`).get(...args) as {n:number}).n);
    const knownTotal=start===0 && checked===total ? items.length : !q.sections && !q.query.trim() ? total : undefined;
    return {source:q.source,status:items.some(r=>r.warnings?.length) ? "partial" : "ok",items,...(knownTotal!==undefined ? {totalMatches:knownTotal} : {}),scan:{checked,undecodable:0,exhausted:start+checked>=total,...(checked===5000 && start+checked<total ? {workLimit:"5000 index candidates"} : {})},query:{sort:total && !dated && sort!=="relevance" ? "source-order" : sort},...(start+checked<total ? {nextCursor:cursor(key,start+checked)} : {}),warnings,
      sourceWarnings:[...state.warnings,...(total && !dated && sort!=="relevance" ? ["Matching records have no occurrence dates; shown in stable source order, not chronology."] : []),...(undated ? [`${undated} otherwise matching records have no supported occurrence date and are excluded from this date window; omit from/to to include them.`] : []),...(q.source === "things-archive" ? ["Historical task statuses are not current assignments."] : []),`Index built ${indexedAt}; changes require an explicit rebuild.`],observedAt:now()};
  } finally { db.close(); }
}
