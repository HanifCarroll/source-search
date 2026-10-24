import { Database } from "bun:sqlite";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import {sourceConfig,type Config} from "../../platform/config";
import {sourceKind} from "../../domain/source-catalog";
import { thingsRecords } from "../local/journals-and-tasks";
import { sourceFiles } from "../local/notes";
import { loadSafeZipArchive,DEFAULT_MAX_ARCHIVE_BYTES } from "../../vendor/takeout/zip";
import { classifyTakeoutEntry, parseTakeoutEntry } from "../../vendor/takeout/parsers";
import { parseChatGptConversationShard, collectChatGptAttachments } from "../../vendor/chatgpt/parser";
import { linkedInRecords, linkedInType, linkedInArticle, linkedInSearchableEntry } from "./linkedin";
import { twitterRecords, twitterCategory, twitterContext, parseTwitterData, twitterSearchableEntry, twitterSearchableTypes } from "./twitter";
import {chatGptGroups} from "./chatgpt";
import { fail, hash, now, versioned, assertVersion } from "../../domain/identity";
import { contained, textFile, regular } from "../../platform/source-files";
import { type Ref, type RecordData } from "../../domain/contracts";

export const archiveSources = ["things-archive", "chatgpt-archive", "takeout-archive", "linkedin-archive", "twitter-archive"] as const;
export type ArchiveSource = typeof archiveSources[number];
export const exportProjectionVersion=(source:ArchiveSource)=>source === "linkedin-archive" ? 6 : source === "twitter-archive" ? 3 : source === "takeout-archive" ? 3 : 1;
export function exportPaths(config:Config,source:ArchiveSource) {
  config=sourceConfig(config,source);
  return source === "things-archive" ? [config.thingsDatabase||config.things] : source === "chatgpt-archive" ? config.chatgpt : source === "linkedin-archive" ? config.linkedin : source === "twitter-archive" ? config.twitter : config.takeout;
}
export async function checkExportSelection(config: Config, source: ArchiveSource) {
  if (source === "things-archive") return;
  const selected = exportPaths(config,source);
  if (!selected.length) fail("SOURCE_NOT_CONFIGURED", "Fresh export has not been downloaded and selected yet");
  for (const path of selected) { const st = await lstat(path); if (st.isSymbolicLink() || !(st.isFile() || source === "chatgpt-archive" && st.isDirectory())) fail("UNSAFE_PATH", "Selected exports must be ordinary ZIP files or ChatGPT export directories"); }
}
export async function archiveSignature(config:Config,source:string) {
  const kind=sourceKind(source,config) as ArchiveSource;
  if(source!==kind)return archiveSignature({...sourceConfig(config,source),sources:{[kind]:config.sources[source]!}},kind);
  config=sourceConfig(config,source);
  if(source === "things-archive")return (await thingsRecords(config)).generation;
  await checkExportSelection(config,source as ArchiveSource);
  const selected=exportPaths(config,source as ArchiveSource), stamps:any[]=[];
  for(const path of selected){const stat=await lstat(path);const paths=stat.isDirectory()?(await sourceFiles(path,n=>/^(?:conversations(?:[-_]?\d+)?|group_chats)\.json$/i.test(n))).paths.map(p=>path+"/"+p):[path];
    for(const file of paths)stamps.push([file,await fileDigest(file)]);}
  return hash(JSON.stringify(source === "twitter-archive" || source === "linkedin-archive" ? [stamps,"content-only-v1"] : stamps));
}
// iCloud can change file metadata without changing the original bytes.
const digestCache=new Map<string,{stamp:string;digest:string}>();
async function fileDigest(path:string){
  const stamp=(s:Awaited<ReturnType<typeof regular>>)=>JSON.stringify([s.size,s.mtimeMs,s.ctimeMs,s.ino]);
  const stat=await regular(path);if(stat.size>DEFAULT_MAX_ARCHIVE_BYTES)fail("SOURCE_LIMIT","Export exceeds the archive byte budget");
  const before=stamp(stat),cached=digestCache.get(path);if(cached?.stamp === before)return cached.digest;
  let bytes=0;const digest=createHash("sha256");for await(const chunk of createReadStream(path)){bytes+=chunk.length;if(bytes>DEFAULT_MAX_ARCHIVE_BYTES)fail("SOURCE_LIMIT","Export grew beyond the archive byte budget");digest.update(chunk);}
  if(before !== stamp(await regular(path)))fail("STALE_RECORD","Original export changed during its content check; retry before rebuilding");
  const result=digest.digest("hex");if(digestCache.size>=128)digestCache.delete(digestCache.keys().next().value!);digestCache.set(path,{stamp:before,digest:result});return result;
}

export async function exportRecords(config: Config, source: ArchiveSource, only?: { part: number; entry: string; messageIndex?:number }) {
  config=sourceConfig(config,source);
  if (source === "things-archive") { const r = await thingsRecords(config); return { ...r, warnings: [] as string[] }; }
  await checkExportSelection(config, source);
  const selected = exportPaths(config,source);
  if (!selected.length) fail("SOURCE_NOT_CONFIGURED", `Select ${source} original export paths in the local configuration after they download`);
  const records = new Map<string, RecordData>(), warnings: string[] = [], categories:{entry:string;records:number;recordType:string}[]=[]; let incompleteMail = 0;
  const conversations={total:0,withMessages:0,empty:0};
  function add(record: RecordData) {
    if (records.size >= 200_000) fail("SOURCE_LIMIT", "Export exceeds the 200,000-record rebuild budget");
    if (records.has(record.ref.id)) fail("INVALID_ARCHIVE", "Duplicate export record identity; select one snapshot and all its parts");
    records.set(record.ref.id, record);
  }
  for (const [part, path] of selected.entries()) {
    if (only && part !== only.part) continue;
    const st = await lstat(path); if (st.isSymbolicLink()) fail("UNSAFE_PATH", "Export links are not followed");
    if(source === "twitter-archive") {
      const zip=await loadSafeZipArchive(path);
      const entries=zip.entries.filter(e=>!e.isDirectory && twitterCategory(e.path));
      if(!entries.length)fail("INVALID_ARCHIVE","X export contains no data/*.js archive entries");
      for(const manifestEntry of entries.filter(e=>twitterCategory(e.path)==="manifest")){
        const manifest=parseTwitterData(new TextDecoder("utf-8",{fatal:true}).decode(await zip.readEntry(manifestEntry)),manifestEntry.path)[0] as any;
        const prefix=manifestEntry.path.replace(/data\/manifest\.(?:js|json)$/i,"");
        const selectedEntries=new Set<string>();
        for(const selectedPath of selected){const selectedZip=selectedPath===path ? zip : await loadSafeZipArchive(selectedPath);for(const e of selectedZip.entries)selectedEntries.add(e.path);}
        const expected=Object.values(manifest.dataTypes || {}).flatMap((v:any)=>Array.isArray(v?.files) ? v.files : []);
        if(expected.some((f:any)=>typeof f.fileName!=="string" || !selectedEntries.has(prefix+f.fileName)))fail("INVALID_ARCHIVE","X manifest references missing data files; select every part of this snapshot before rebuilding");
        if(manifest.archiveInfo?.isPartialArchive)warnings.push("X labels this as a partial archive; coverage is limited to the data actually included.");
      }
      for(const entry of entries){
        if(!twitterSearchableEntry(entry.path) || only && entry.path!==only.entry)continue;
        const text=new TextDecoder("utf-8",{fatal:true}).decode(await zip.readEntry(entry));
        const parsed=twitterRecords(text,path,entry.path,part);
        for(const category of parsed.categories)if(twitterSearchableTypes.has(category.recordType))categories.push(category);
        for(const record of parsed.records)if(twitterSearchableTypes.has(record.type))add(record);
      }
      const other=zip.entries.filter(e=>!e.isDirectory && !twitterCategory(e.path));
      warnings.push(`Selected X snapshot only; ${other.length} media/viewer/other files are not text-indexed. Media bytes are preserved in the original archive. Likes/reposts do not establish authorship; absent/deleted content cannot be recovered from this snapshot. Long posts, articles and Grok messages have text projections. Only posts, long posts, articles, likes, readable DMs and Grok chats are indexed. Account/admin data, headers, security records and encrypted Chat events remain in the original ZIP and are excluded from search.`);
    } else if(source === "linkedin-archive") {
      const zip=await loadSafeZipArchive(path);
      const entries=zip.entries.filter(e=>!e.isDirectory);
      if(!entries.some(e=>/\.csv$/i.test(e.path)))fail("INVALID_ARCHIVE","LinkedIn export contains no CSV files");
      for(const entry of entries) {
        if(!linkedInSearchableEntry(entry.path) || only && entry.path!==only.entry)continue;
        if(!/\.csv$/i.test(entry.path) && !/^Articles\/.*\.html$/i.test(entry.path)){warnings.push(`Unsupported entry: ${basename(entry.path)}`);continue;}
        const text=new TextDecoder("utf-8",{fatal:true}).decode(await zip.readEntry(entry));
        const parsed=/\.csv$/i.test(entry.path) ? linkedInRecords(text,path,entry.path,part) : [linkedInArticle(text,path,entry.path,part)];
        categories.push({entry:entry.path,records:parsed.length,recordType:linkedInType(entry.path)});
        for(const record of parsed)add(record);
      }
      warnings.push("Selected LinkedIn snapshot only; category counts describe the files actually selected. Account, ad, inference and search-log categories remain in the original ZIP and are excluded from search. Uploaded media and attachment contents are not searched. Unknown timezones retain calendar-day precision; date windows include overlapping days.");
    } else if (source === "chatgpt-archive") {
      const zip = st.isFile() ? await loadSafeZipArchive(path) : undefined;
      const paths = zip ? zip.entries.filter(e => !e.isDirectory && /(^|\/)(?:conversations(?:[-_]?\d+)?|group_chats)\.json$/i.test(e.path)).map(e => e.path) : (await sourceFiles(path, n => /^(?:conversations(?:[-_]?\d+)?|group_chats)\.json$/i.test(n))).paths;
      if (!paths.length) fail("INVALID_ARCHIVE", "ChatGPT export contains no conversation shards");
      for (const shard of paths.filter(p=>!only || p === only.entry)) {
        const text = zip ? new TextDecoder("utf-8", { fatal: true }).decode(await zip.readEntry(zip.entries.find(e => e.path === shard)!)) : await textFile(await contained(path, shard), 512 * 1024 * 1024);
        if(/(^|\/)group_chats\.json$/i.test(shard)){
          const groups=chatGptGroups(JSON.parse(text),path,shard,part);for(const r of groups.records)add(r);
          conversations.total+=groups.conversations.total;conversations.withMessages+=groups.conversations.withMessages;conversations.empty+=groups.conversations.empty;
          warnings.push("Group-chat exports identify roles, not individual senders, and have no branch metadata; selectedBranch filters exclude those messages. Group context is chronological.");
          continue;
        }
        for (const c of parseChatGptConversationShard(JSON.parse(text), shard)) {
          conversations.total++; conversations[c.messages.length ? "withMessages" : "empty"]++;
          for (const m of c.messages) {
            const attachments = collectChatGptAttachments(m.rawMessage, { shardPath: shard, sourceAccountId: "selected-export" });
            add(versioned({ ref: { source, id: hash(JSON.stringify([part, c.conversationId, m.messageId])) }, title: c.title || "ChatGPT conversation", body: m.contentText || "", type: "chatgpt-message", author: m.role, conversation: c.conversationId, occurredAt: m.occurredAt?.toISOString(), observedAt: now(), locator: path + "#" + encodeURIComponent(shard) + "/" + encodeURIComponent(m.nodeId), metadata: { exportPath: path, shard, conversationId: c.conversationId, messageId: m.messageId, nodeId: m.nodeId, parentId: m.parentId, childIds: m.childIds, selectedBranch: m.selectedBranch, contentType: m.contentType, model: m.modelSlug, attachments, sourceTimestamp: m.sourceCreateTime,textAvailable:!!m.contentText,...(!m.contentText ? {originalContent:m.rawMessage.content} : {}) }, warnings: [...(attachments.length ? ["Attachment pointers are retained; attachment bytes are not searched."] : []),...(!m.contentText ? ["This message has no exported text. Its content structure is available with details:true; media bytes are not searched."] : [])] }));
          }
        }
      }
      warnings.push("Historical ChatGPT export: all conversation branches and author roles are retained; media bytes, codex.json and non-conversation account files are not searched.");
    } else {
      if (!st.isFile()) fail("INVALID_ARCHIVE", "Google Takeout expects all ZIP parts from one selected export");
      const zip = await loadSafeZipArchive(path, { maxEntryBytes: 768 * 1024 * 1024 }); // Actual Gmail MBOX is 549 MB; retain a bounded read.
      for (const entry of zip.entries.filter(e => !e.isDirectory && (!only || e.path === only.entry))) {
        const classified = classifyTakeoutEntry(entry);
        if (classified.kind.startsWith("ignored")) { warnings.push(`Unsupported entry: ${basename(entry.path)}`); continue; }
        const bytes = await zip.readEntry(entry), parsed = await parseTakeoutEntry(classified, bytes, { archiveSha256: zip.archiveSha256, archiveBytes: zip.archiveBytes, importedAt: new Date(0), sourceAccountId: "selected-export", entry, entrySha256: entry.sha256! },only?.messageIndex);
        if (parsed.incomplete) fail("INVALID_ARCHIVE", `Malformed export entry: ${entry.path}; old index retained`);
        if (parsed.warning) warnings.push(parsed.warning);
        for (const item of parsed.items) {
          const original = (item.rawCapture?.raw as any)?.record;
          const mimeWarnings = item.metadata?.mimeWarnings as string[] | undefined;
          if (mimeWarnings?.length) incompleteMail++;
          const date = item.occurredAt instanceof Date ? item.occurredAt.toISOString() : item.occurredAt;
          add(versioned({ ref: { source, id: hash(JSON.stringify([part, entry.path, item.sourceItemId])) }, title: item.title || entry.path, body: (item.contentText || "") + (item.itemType === "email" ? "" : "\n\nOriginal export record\n" + JSON.stringify(original)), type: item.itemType, warnings: mimeWarnings, occurredAt: date, observedAt: now(), locator: path + "#" + encodeURIComponent(entry.path), author: item.participants?.find(p => p.role === "author")?.id, metadata: { exportPath: path, entry: entry.path, nativeId: item.sourceItemId, archiveSha256: zip.archiveSha256, originalRecordIndex: original?.messageIndex ?? original?.recordIndex ?? original?.rowNumber, ...(item.itemType === "email" ? { headers: original?.headers, labels: original?.labels, attachmentsNotSearched: true } : {}), participants: item.participants } }));
        }
        if (parsed.archiveOnly) {
          const raw = parsed.archiveOnly.raw as any;
          add(versioned({ ref: { source, id: hash(JSON.stringify([part, entry.path, "settings"])) }, title: entry.path, body: raw.text || JSON.stringify(raw.parsed), type: "account-settings", observedAt: now(), locator: path + "#" + encodeURIComponent(entry.path), metadata: { administrative: true, exportPath: path, entry: entry.path } }));
        }
      }
      warnings.push("Selected historical Takeout products; unsupported entries are reported. Live Gmail and Calendar remain separate sources.");
    }
  }
  if (incompleteMail) warnings.push(`Incomplete MIME text in ${incompleteMail} email records; originals are retained in the selected MBOX archive`);
  const unsupported = warnings.filter(w => w.startsWith("Unsupported entry:"));
  const reported = [...new Set([...warnings.filter(w => !w.startsWith("Unsupported entry:")), ...unsupported.slice(0, 20), ...(unsupported.length > 20 ? [`${unsupported.length} unsupported entries; first 20 shown`] : [])])];
  const generation = hash(JSON.stringify([...records.values()].map(r => r.ref)));
  return { records, generation, warnings: reported, info: { taskCount: undefined, exportedAt: undefined, categories:source === "linkedin-archive" || source === "twitter-archive" ? categories : undefined,conversations:source === "chatgpt-archive" ? conversations : undefined } };
}
export async function readExport(config: Config, ref: Ref) {
  config=sourceConfig(config,ref.source);
  if (ref.source === "things-archive") { const { readThings } = await import("../local/journals-and-tasks"); return readThings(config, ref); }
  const r = (await exportOriginals(config,ref)).records.get(ref.id);
  if (!r) fail("RECORD_NOT_FOUND", "Record is absent from the selected current export");
  assertVersion(ref, r.ref.version!); return r;
}
export async function twitterArchiveContext(config:Config,record:RecordData) {
  const original=await cachedOriginals(config,"twitter-archive");
  const latest=original.records.get(record.ref.id);
  if(!latest)fail("RECORD_NOT_FOUND","X record disappeared before the context read");
  assertVersion(record.ref,latest.ref.version!);
  return twitterContext(record,[...original.records.values()]);
}
export async function linkedInContext(config:Config,record:RecordData) {
  if(!record.conversation)return {records:[],warnings:["This LinkedIn record has no exported message conversation."]};
  const original=config.linkedin.length>1 ? await cachedOriginals(config,"linkedin-archive") : await exportOriginals(config,record.ref),latest=original.records.get(record.ref.id);
  if(!latest)fail("RECORD_NOT_FOUND","LinkedIn message disappeared before the context read");
  assertVersion(record.ref,latest.ref.version!);
  const messages=[...original.records.values()].filter(r=>r.type==="linkedin-message" && r.conversation===record.conversation).sort((a,b)=>(a.occurredAt || "").localeCompare(b.occurredAt || "") || Number(a.metadata?.row)-Number(b.metadata?.row));
  const at=messages.findIndex(r=>r.ref.id===record.ref.id);
  return {records:messages.slice(Math.max(0,at-5),at+6).filter(r=>r.ref.id!==record.ref.id).map(r=>({ref:r.ref,title:r.title,author:r.author,occurredAt:r.occurredAt,conversation:r.conversation,type:r.type,excerpt:r.body.slice(0,500)})),warnings:messages.length>11 ? ["Conversation context contains up to five messages on each side; search this conversation to continue."] : []};
}
async function exportOriginals(config:Config,ref:Ref) {
  let only: { part: number; entry: string; messageIndex?:number } | undefined;
  if (ref.source === "takeout-archive" || ref.source === "chatgpt-archive" || ref.source === "linkedin-archive" || ref.source === "twitter-archive") {
    // Use the disposable index only for a validated locator; content still comes from the original export.
    let db: Database | undefined;
    try {
      await regular(config.index); db = new Database(config.index, { readonly: true });
      const cached = db.query("SELECT data FROM records WHERE source=? AND id=?").get(ref.source, ref.id) as { data: string } | null;
      const metadata = cached && JSON.parse(cached.data).metadata;
      const part = metadata ? exportPaths(config,ref.source).indexOf(metadata.exportPath) : -1;
      const entry = ref.source === "chatgpt-archive" ? metadata?.shard : metadata?.entry;
      if (part >= 0 && typeof entry === "string") only = { part, entry,...(ref.source === "takeout-archive" && Number.isSafeInteger(metadata.originalRecordIndex) && /\.mbox$/i.test(entry) ? {messageIndex:metadata.originalRecordIndex} : {}) };
    } catch { /* Missing cache falls back to original export discovery. */ }
    finally { db?.close(); }
  }
  return cachedOriginals(config, ref.source as ArchiveSource, only);
}
export async function chatGptContext(config:Config,record:RecordData) {
  const original=await exportOriginals(config,record.ref), byNode=new Map([...original.records.values()].filter(r=>r.conversation === record.conversation).map(r=>[r.metadata?.nodeId,r]));
  const latest=original.records.get(record.ref.id);if(!latest)fail("RECORD_NOT_FOUND","Message disappeared before the context read");assertVersion(record.ref,latest.ref.version!);
  const compact=(r:RecordData)=>({ref:r.ref,title:r.title.slice(0,250),author:r.author,occurredAt:r.occurredAt,conversation:r.conversation,type:r.type,locator:r.locator,excerpt:r.body.slice(0,500),metadata:{selectedBranch:r.metadata?.selectedBranch,contentType:r.metadata?.contentType}});
  if(record.metadata?.group){
    const messages=[...original.records.values()].filter(r=>r.conversation === record.conversation).sort((a,b)=>a.occurredAt!.localeCompare(b.occurredAt!) || a.ref.id.localeCompare(b.ref.id)),at=messages.findIndex(r=>r.ref.id === record.ref.id);
    return {records:messages.slice(Math.max(0,at-5),at+6).filter(r=>r.ref.id !== record.ref.id).map(compact),warnings:["Group context is chronological, limited to five messages on each side; sender identities are not exported."]};
  }
  const before:RecordData[]=[],after:RecordData[]=[],warnings:string[]=[];
  let current=record;
  for(let i=0;i<5;i++){const parent=byNode.get(current.metadata?.parentId);if(!parent)break;before.unshift(parent);current=parent;}
  current=record;
  for(let i=0;i<5;i++){
    const children=((current.metadata?.childIds || []) as string[]).map(id=>byNode.get(id)).filter((r):r is RecordData=>!!r);
    const next=current.metadata?.selectedBranch ? children.find(r=>r.metadata?.selectedBranch) : children.length === 1 ? children[0] : undefined;
    if(!next){if(children.length)warnings.push("Context stops at a branch fork; search this conversation to inspect alternate replies.");break;}
    after.push(next);current=next;
  }
  if(before.length === 5 || after.length === 5)warnings.push("Context is limited to five ancestors and five following messages; search this conversation for more.");
  return {records:[...before,...after].map(compact),warnings};
}

// shortcut: two parsed entries/selected mailbox records are retained up to 32 MB each; compressed ZIPs still require bounded decompression on cold reads.
const originalCache = new Map<string, Awaited<ReturnType<typeof exportRecords>>>();
const pendingOriginals = new Map<string, Promise<Awaited<ReturnType<typeof exportRecords>>>>();
let cacheEnabled = true;
export function disposeOriginalCache() { cacheEnabled=false; originalCache.clear(); pendingOriginals.clear();digestCache.clear(); }
async function cachedOriginals(config: Config, source: ArchiveSource, only?: {part:number;entry:string;messageIndex?:number}) {
  await checkExportSelection(config,source);
  const paths=exportPaths(config,source);
  // Folder exports may change inside the directory; do not cache those by directory mtime.
  const stats=await Promise.all(paths.map(async p=>{const s=await lstat(p);return [p,s.size,s.mtimeMs,s.ctimeMs,s.isDirectory()];}));
  if(stats.some(s=>s[4])) return exportRecords(config,source,only);
  const key=hash(JSON.stringify([source,stats,only]));
  const existing=originalCache.get(key); if(existing)return existing;
  const pending=pendingOriginals.get(key);if(pending)return pending;
  const work=exportRecords(config,source,only).then(async result=>{
    const after=await Promise.all(paths.map(async p=>{const s=await lstat(p);return [p,s.size,s.mtimeMs,s.ctimeMs,s.isDirectory()];}));
    if(JSON.stringify(after)!==JSON.stringify(stats)) fail("STALE_RECORD","Original export changed while reading; search again");
    const bytes=[...result.records.values()].reduce((n,r)=>n+Buffer.byteLength(r.body)+Buffer.byteLength(JSON.stringify(r.metadata || {})),0);
    if(cacheEnabled && bytes<=32*1024*1024){if(originalCache.size>=2)originalCache.delete(originalCache.keys().next().value!);originalCache.set(key,result);}
    return result;
  }).finally(()=>pendingOriginals.delete(key));
  pendingOriginals.set(key,work);return work;
}
