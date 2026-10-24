import {sourceFiles} from "./notes";
import {noteDate} from '../../formats/note-date';
import {markdownSettings} from '../../platform/config';
import { findRecordMatch } from "../../domain/content";
import { recordPage } from "../../domain/pages";
import { lstat } from "node:fs/promises";
import { fail, now, hash, queryKey, numberPosition, cursor, assertVersion } from "../../domain/identity";
import { within, hit } from "../../domain/results";
import { contained, textFile } from "../../platform/source-files";
import { type RecordData, type Query, type Page, type Ref } from "../../domain/contracts";
import type { Config } from "../../platform/config";

export function isDailyJournal(config:Config,source:string){
  const s=markdownSettings(config,source);
  return s.content==='journal' && s.dateFromFilename && s.dateFields.length===0 && s.pattern==='**/????-??-??.md';
}
export async function journalPaths(root:string,exclude:string[]=[]){
  const listing=await sourceFiles(root,name=>/^\d{4}-\d{2}-\d{2}\.md$/.test(name.split('/').pop()!),exclude);
  return {...listing,paths:listing.paths.reverse()};
}
export async function journalRecord(config: Config, ref: Ref): Promise<RecordData> {
  if (!/^.*\d{4}-\d{2}-\d{2}\.md$/.test(ref.id)) fail("INVALID_REFERENCE", "Expected a daily journal record");
  if(markdownSettings(config,ref.source).exclude.some(pattern=>new Bun.Glob(pattern).match(ref.id)))fail("INVALID_REFERENCE","File is outside the configured Markdown selection");
  const path = await contained(markdownSettings(config,ref.source).root, ref.id), body = await textFile(path), version = hash(body);
  assertVersion(ref, version); const day = ref.id.match(/(\d{4}-\d{2}-\d{2})\.md$/)![1];
  return { adapter:"markdown", ref: { source: ref.source, id: ref.id, version }, title: day, body, type: "written-journal", locator: path,
    occurredAt: noteDate(day,markdownSettings(config,ref.source).timeZone || config.timeZone), observedAt: now(), ...(markdownSettings(config,ref.source).author?{author:markdownSettings(config,ref.source).author}:{}), metadata: { datePrecision: "day", timezone: markdownSettings(config,ref.source).timeZone || config.timeZone, modifiedAt: (await lstat(path)).mtime.toISOString() } };
}
export async function searchJournals(config: Config, q: Query): Promise<Page> {
  if (q.conversation) fail("UNSUPPORTED_FILTER", "Journals have no conversation filter");
  const { paths, warnings } = await journalPaths(markdownSettings(config,q.source).root,markdownSettings(config,q.source).exclude);
  if(q.sort === "oldest")paths.reverse();
  if(q.sort === "relevance"){if(paths.length>1000)fail("SOURCE_LIMIT","Relevance ordering supports up to 1,000 journal notes; use newest/oldest with continuation");return recordPage(await Promise.all(paths.map(id=>journalRecord(config,{source:q.source,id}))),q,warnings);}
  const key = queryKey(q) + hash(paths.join("\n")), start = numberPosition(q.cursor, key);
  if (start > paths.length) fail("STALE_CURSOR", "Journal listing changed; start a new search");
  const items = []; let offset = start, checked = 0;
  while (offset < paths.length && items.length < q.limit && checked < 1000) {
    checked++;
    const id = paths[offset++];
    try { const r = await journalRecord(config, { source: q.source, id }); if (within(r.occurredAt, q) && findRecordMatch(r,q)) { const h = hit(r, q, offset); h.cursorAfter = cursor(key, offset); items.push(h); } }
    catch (e) { warnings.push((e as Error).message); }
  }
  if (checked >= 1000 && offset < paths.length) warnings.push("Search paused at the 1,000-file work limit; continue with the cursor");
  return { source: q.source, status: warnings.length ? "partial" : "ok", items,scan:{checked,undecodable:0,exhausted:offset>=paths.length,...(checked>=1000 && offset<paths.length ? {workLimit:"1000 files"} : {})}, ...(offset < paths.length ? { nextCursor: cursor(key, offset) } : {}), warnings: [...new Set(warnings)].slice(0, 5), observedAt: now() };
}
