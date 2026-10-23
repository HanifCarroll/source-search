import {noteDate} from '../../formats/note-date';
import {markdownSettings} from '../../platform/config';
import {frontmatterFields} from "../../formats/frontmatter";
import { readdir, lstat } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import type { Config } from "../../platform/config";
import { fail, now, assertVersion, versioned } from "../../domain/identity";
import { contained, textFile } from "../../platform/source-files";
import { type Ref, type RecordData, type Query } from "../../domain/contracts";
import { recordPage } from "../../domain/pages";

export async function sourceFiles(root: string, accept: (name: string) => boolean, exclude:string[] = []) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH", "Source root must be an ordinary directory");
  const paths: string[] = [], warnings: string[] = []; let count = 0;
  async function walk(folder: string, depth: number) {
    if (depth > 40) fail("SOURCE_LIMIT", "Source nesting exceeds the discovery budget");
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++count > 20_000) fail("SOURCE_LIMIT", "Source discovery exceeds the file budget");
      const name=relative(root,join(folder,entry.name));
      if(exclude.some(pattern=>new Bun.Glob(pattern).match(name) || entry.isDirectory() && new Bun.Glob(pattern).match(name+"/")))continue;
      if (entry.isSymbolicLink()) { warnings.push("Source links are not followed"); continue; }
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && accept(relative(root,path))) paths.push(relative(root, path));
    }
  }
  await walk(root, 0); return { paths: paths.sort(), warnings: [...new Set(warnings)] };
}
function matchesNote(config:Config,source:string,name:string){const s=markdownSettings(config,source);return new Bun.Glob(s.pattern).match(name) && !s.exclude.some(p=>new Bun.Glob(p).match(name));}
export async function notesStatus(config:Config,source:string){const s=markdownSettings(config,source),d=await sourceFiles(s.root,name=>matchesNote(config,source,name),s.exclude);return {records:d.paths.length,warnings:d.warnings,coverage:'Configured Markdown files; dates and content labels follow this source configuration'};}
export async function readNote(config:Config,ref:Ref):Promise<RecordData>{
 const s=markdownSettings(config,ref.source);
 if(!matchesNote(config,ref.source,ref.id))fail('INVALID_REFERENCE','File is outside the configured Markdown selection');
 const path=await contained(s.root,ref.id),body=await textFile(path),fields=frontmatterFields(body,s.dateFields),field=(name:string)=>fields[name];
 const date=s.dateFields.map(field).find(Boolean) || (s.dateFromFilename?basename(ref.id).match(/^(\d{4}-\d{2}-\d{2})(?:\D|$)/)?.[1]:undefined);
 const occurredAt=noteDate(date,s.timeZone || config.timeZone),transcription=s.content==='transcript';
 const r=versioned({adapter:'markdown',ref:{source:ref.source,id:ref.id},body,title:basename(ref.id,'.md'),type:transcription?(s.reviewed?'reviewed-transcript-note':'transcript-note'):s.content==='journal'?'written-journal':'note',locator:path,occurredAt,observedAt:now(),...(s.author?{author:s.author}:{}),
 metadata:{...(transcription?{transcription:true,muesliMeetingId:field('source')==='muesli' && /^\d+$/.test(field('muesli_meeting_id') || '')?field('muesli_meeting_id'):undefined,sourceLocator:field('source_audio') || field('source_locator'),backend:field('backend'),model:field('model')}:{}),datePrecision:date?.length===10?'day':'timestamp'},
 ...(transcription?{warnings:['This is the retained source note, not newly transcribed audio; its original quality warnings remain in the text.']}: {})});
 assertVersion(ref,r.ref.version!);return r;
}
export async function searchNotes(config: Config, q: Query) {
  if (q.conversation) fail("UNSUPPORTED_FILTER", "Markdown notes do not have native conversation filters");
  const d = await sourceFiles(markdownSettings(config,q.source).root, name => matchesNote(config,q.source,name),markdownSettings(config,q.source).exclude), records: RecordData[] = [];
  // shortcut: retained notes are small; use bounded direct reads until measured volume warrants an index.
  if (d.paths.length > 1000) fail("SOURCE_LIMIT", "More than 1,000 Markdown notes require a dedicated index");
  for (const id of d.paths) { try { records.push(await readNote(config, { source: q.source, id })); } catch { d.warnings.push("A source note could not be read; coverage is incomplete"); } }
  records.sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || "") || a.ref.id.localeCompare(b.ref.id));
  return recordPage(records, q, [...new Set(d.warnings)]);
}
