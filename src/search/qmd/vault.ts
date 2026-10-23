import { Database } from "bun:sqlite";
import { access } from "node:fs/promises";
import type { Config } from "../../platform/config";
import { fail, now, hash, numberPosition, queryKey, cursor } from "../../domain/identity";
import { contained, textFile } from "../../platform/source-files";
import { hit } from "../../domain/results";
import { type Query, type Ref, type Page, type RecordData } from "../../domain/contracts";

const candidateLimit = 100;
type Indexed = { collection: string; path: string; title: string; hash: string; doc: string };
import { runQmd, type QmdRun } from "./runner";
function open(c: Config) {
  // The QMD cache uses WAL. macOS SQLite needs to create its auxiliary WAL/SHM
  // files when QMD removed them on close; a read-only file handle cannot do that.
  // Open only an existing cache and prohibit SQL writes. Never open originals here.
  const db = new Database(c.qmdDatabase, { create: false, strict: true });
  db.exec("PRAGMA query_only=ON");
  return db;
}
export async function qmdStatus(c: Config) {
  const db = open(c);
  try {
    const collections = Object.keys(c.qmdRoots);
    if (!collections.length) fail("SOURCE_NOT_CONFIGURED", "Configure QMD collections before searching");
    const marks = collections.map(() => "?").join(",");
    const state = db.query(`SELECT count(*) records, sum(CASE WHEN NOT EXISTS (SELECT 1 FROM content_vectors v WHERE v.hash=d.hash) THEN 1 ELSE 0 END) pending FROM documents d WHERE active=1 AND collection IN (${marks})`).get(...collections) as { records: number; pending: number | null };
    const vectorIndexPresent = !!db.query("SELECT 1 FROM sqlite_master WHERE name='vectors_vec'").get();
    const modelsPresent = c.qmdModels.length === 3 && (await Promise.all(c.qmdModels.map(p => access(p).then(() => true, () => false)))).every(Boolean);
    return { available: state.records > 0, records: state.records, semanticReady: state.records > 0 && !state.pending && modelsPresent && vectorIndexPresent, pendingEmbeddings: state.pending || 0, vectorIndexPresent, modelsPresent, collections, coverage: "Configured Markdown collections; ranked candidate discovery, not exhaustive enumeration", warnings: state.pending ? [`${state.pending} documents still need embeddings; run QMD embed`] : [], configuredPath: c.qmdDatabase };
  } finally { db.close(); }
}
// QMD 1.0.7 normalizes index paths. Resolve them back to exact original filenames;
// never treat a normalized index path as an original filesystem path.
export function qmdPath(path: string) {
  return path.replace(/___/g,"/").toLowerCase().split("/").map((segment,index,all) => {
    const ext = index === all.length-1 ? segment.match(/(\.[a-z0-9]+)$/i)?.[1] || "" : "";
    return (ext ? segment.slice(0,-ext.length) : segment).replace(/[^\p{L}\p{N}$]+/gu,"-").replace(/^-+|-+$/g,"") + ext;
  }).filter(Boolean).join("/");
}
async function originalPaths(c: Config) {
  const paths = new Map<string, { root: string; path: string }>();
  for (const [collection, root] of Object.entries(c.qmdRoots)) {
    for await (const path of new Bun.Glob("**/*.md").scan({ cwd: root, followSymlinks: false, dot: false, onlyFiles: true })) {
      const key = `qmd://${collection}/${qmdPath(path)}`;
      if (paths.has(key)) fail("AMBIGUOUS_REFERENCE", `Two originals normalize to ${key}; resolve the collision before searching`);
      paths.set(key, { root, path });
    }
  }
  return paths;
}
function indexed(c: Config, db: Database, id: string): Indexed {
  const match = /^qmd:\/\/([a-zA-Z0-9_-]+)\/(.+)$/.exec(id);
  if (!match || !c.qmdRoots[match[1]!]) fail("INVALID_REFERENCE", "Unconfigured QMD collection");
  const row = db.query("SELECT d.collection,d.path,d.title,d.hash,c.doc FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1 AND d.collection=? AND d.path=?").get(match[1]!,match[2]!) as Indexed | null;
  if (!row) fail("STALE_RECORD", "QMD record no longer exists in the active index");
  return row;
}
export async function searchQmd(c: Config, input: Query, execute: QmdRun = request => runQmd(request, c)): Promise<Page> {
  const q = { ...input, mode: input.mode ?? "hybrid" };
  if (!q.query.trim()) fail("INVALID_QUERY", "QMD requires a nonempty discovery query");
  const state = await qmdStatus(c);
  if (!state.available || q.mode !== "lexical" && !state.semanticReady) fail("SOURCE_NOT_READY", "QMD embeddings/models are not ready; complete the explicit setup or request lexical mode");
  const raw = await execute({index:"vault",mode:q.mode,query:q.query});
  if (!Array.isArray(raw) || raw.some(r => typeof r.file !== "string" || typeof r.score !== "number")) fail("INVALID_PROVIDER_RESPONSE", "Invalid QMD search results");
  const paths = await originalPaths(c), db = open(c), records: RecordData[] = [], seen = new Set<string>();
  const warnings = ["Bounded ranked discovery: at most 100 candidates (QMD hybrid reranks up to 40). End of these pages does not mean the collection was exhaustively searched."];
  try {
    for (const r of raw.slice(0,candidateLimit)) {
      // Do not leak results from an accidentally expanded QMD config.
      if (!paths.has(r.file)) { warnings.push("An indexed file is outside the configured collections or no longer present; refresh QMD."); continue; }
      const row = indexed(c,db,r.file);
      if(seen.has(row.hash))continue;
      seen.add(row.hash);
      const origin = paths.get(r.file)!;
      const locator = await contained(origin.root,origin.path);
      records.push({ ref: {source:"vault",id:r.file,version:row.hash}, title:row.title, body:String(r.snippet || ""), type:"vault-document", locator, observedAt:now(), metadata:{previewOnly:true,collection:row.collection,score:r.score} });
    }
  } finally { db.close(); }
  const key = queryKey(q)+hash(JSON.stringify(records.map(r=>r.ref))), start=numberPosition(q.cursor,key);
  if(start>records.length)fail("INVALID_CURSOR","Cursor exceeds the ranked QMD candidates");
  const selected=records.slice(start,start+q.limit);
  return { source:"vault",status:warnings.length>1?"partial":"ok",items:selected.map((r,i)=>{const h=hit(r,q,start+i+1);h.cursorAfter=cursor(key,start+i+1);return h;}), ...(start+selected.length<records.length?{nextCursor:cursor(key,start+selected.length)}:{}),warnings,observedAt:now(),retrieval:{requestedMode:q.mode,effectiveMode:q.mode} };
}
export async function readQmd(c: Config, ref: Ref): Promise<RecordData> {
  const db=open(c);let row: Indexed;
  try { row=indexed(c,db,ref.id); } finally { db.close(); }
  if(ref.version && ref.version!==row.hash)fail("STALE_RECORD","QMD index changed; search again");
  const origin=(await originalPaths(c)).get(ref.id);
  if(!origin)fail("STALE_RECORD","Original QMD file is no longer present");
  const locator=await contained(origin.root,origin.path), body=await textFile(locator);
  if(hash(body)!==row.hash)fail("STALE_RECORD","Original changed since QMD indexing; refresh QMD before citing it");
  return {ref:{...ref,version:row.hash},title:row.title,body,type:"vault-document",locator,observedAt:now(),metadata:{collection:row.collection,indexedContentHash:row.hash},warnings:["QMD index is a snapshot; this read verified it against the original Markdown file. Source dates are not inferred from file modification times."]};
}
