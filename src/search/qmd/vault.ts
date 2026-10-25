import {focusToken} from '../../domain/content';
import {qmdIndex,qmdResults,type QmdIndex,type IndexedDocument as Indexed} from "../../vendor/qmd";
import { access } from "node:fs/promises";
import type { Config } from "../../platform/config";
import { fail, now, hash, numberPosition, queryKey, cursor } from "../../domain/identity";
import { contained, textFile } from "../../platform/source-files";
import { hit } from "../../domain/results";
import { type Query, type Ref, type Page, type RecordData } from "../../domain/contracts";

const candidateLimit = 100;
import { runQmd, modelsPresent as checkModels, type QmdRun } from "./runner";
const open=(c:Config)=>qmdIndex(c.qmdDatabase);
export async function qmdStatus(c: Config) {
  const db = open(c);
  try {
    const collections = Object.keys(c.qmdRoots);
    if (!collections.length) fail("SOURCE_NOT_CONFIGURED", "Configure QMD collections before searching");
    const state=db.collections(collections).reduce((sum,row)=>({records:sum.records+row.indexedDocuments,pending:sum.pending+row.pending}),{records:0,pending:0});
    const vectorIndexPresent=db.hasVectorIndex();
    const modelsPresent = await checkModels(c);
    return { available: state.records > 0, records: state.records, semanticReady: state.records > 0 && !state.pending && modelsPresent && vectorIndexPresent, pendingEmbeddings: state.pending || 0, vectorIndexPresent, modelsPresent, collections, coverage: "Configured Markdown collections; ranked candidate discovery, not exhaustive enumeration", warnings: state.pending ? [`${state.pending} documents still need embeddings; run source-search index --embed`] : [], configuredPath: c.qmdDatabase };
  } finally { db.close(); }
}
// Old indexes normalized paths. Keep those saved references as aliases while
// current SDK indexes use literal relative filenames.
export function qmdPath(path: string) {
  return path.replace(/___/g,"/").toLowerCase().split("/").map((segment,index,all) => {
    const ext = index === all.length-1 ? segment.match(/(\.[a-z0-9]+)$/i)?.[1] || "" : "";
    return (ext ? segment.slice(0,-ext.length) : segment).replace(/[^\p{L}\p{N}$]+/gu,"-").replace(/^-+|-+$/g,"") + ext;
  }).filter(Boolean).join("/");
}
async function originalPaths(c: Config) {
  const paths = new Map<string, { root: string; path: string }>(), legacy = new Map<string, {root:string;path:string}[]>();
  for (const [collection, root] of Object.entries(c.qmdRoots)) {
    for await (const path of new Bun.Glob("**/*.md").scan({ cwd: root, followSymlinks: false, dot: false, onlyFiles: true })) {
      const original={root,path},key=`qmd://${collection}/${qmdPath(path)}`;
      paths.set(`qmd://${collection}/${path}`,original);
      legacy.set(key,[...(legacy.get(key)||[]),original]);
    }
  }
  return {get(id:string){const candidates=legacy.get(id);if(candidates && candidates.length>1)fail('AMBIGUOUS_REFERENCE',`Two originals normalize to ${id}; use a current literal path reference`);return paths.get(id)||candidates?.[0];},has(id:string){return !!this.get(id);}};
}
function indexed(c: Config, db: QmdIndex, id: string, originalPath?:string): Indexed {
  const match = /^qmd:\/\/([a-zA-Z0-9_-]+)\/(.+)$/.exec(id);
  if (!match || !c.qmdRoots[match[1]!]) fail("INVALID_REFERENCE", "Unconfigured QMD collection");
  const row=db.document(match[1]!,match[2]!) || (originalPath?db.document(match[1]!,originalPath):undefined);
  if (!row) fail("STALE_RECORD", "QMD record no longer exists in the active index");
  return row;
}
export async function searchQmd(c: Config, input: Query, execute: QmdRun = request => runQmd(request, c)): Promise<Page> {
  const q = { ...input, mode: input.mode ?? "hybrid" };
  if (!q.query.trim()) fail("INVALID_QUERY", "QMD requires a nonempty discovery query");
  const state = await qmdStatus(c);
  if (!state.available || q.mode !== "lexical" && !state.semanticReady) fail("SOURCE_NOT_READY", "QMD embeddings/models are not ready; complete the explicit setup or request lexical mode");
  const raw = qmdResults(await execute({index:"vault",mode:q.mode,query:q.query,...(q.plan?{plan:q.plan}:{}),...(q.depth?{depth:q.depth}:{})}));
  const paths = await originalPaths(c), db = open(c), records: RecordData[] = [], seen = new Set<string>();
  const focused=new Map<string,string>();
  const warnings = ["Bounded ranked discovery: at most 100 candidates (QMD hybrid reranks up to 40). End of these pages does not mean the collection was exhaustively searched."];
  try {
    for (const r of raw.slice(0,candidateLimit)) {
      // Do not leak results from an accidentally expanded QMD config.
      if (!paths.has(r.file)) { warnings.push("An indexed file is outside the configured collections or no longer present; refresh the index."); continue; }
      const row = indexed(c,db,r.file);
      if(seen.has(row.hash))continue;
      seen.add(row.hash);
      if(r.passage && r.passage.end<=row.doc.length)focused.set(r.file,focusToken({ref:{source:'vault',id:r.file,version:row.hash},body:row.doc} as RecordData,{field:'body',...r.passage}));
      const origin = paths.get(r.file)!;
      const locator = await contained(origin.root,origin.path);
      records.push({ ref: {source:"vault",id:r.file,version:row.hash}, title:row.title, body:String(r.snippet || ""), type:"vault-document", locator, observedAt:now(), metadata:{previewOnly:true,collection:row.collection,score:r.score} });
    }
  } finally { db.close(); }
  const key = queryKey(q)+hash(JSON.stringify(records.map(r=>r.ref))), start=numberPosition(q.cursor,key);
  if(start>records.length)fail("INVALID_CURSOR","Cursor exceeds the ranked QMD candidates");
  const selected=records.slice(start,start+q.limit);
  return { source:"vault",status:warnings.length>1?"partial":"ok",items:selected.map((r,i)=>{const h=hit(r,q,start+i+1);if(focused.has(r.ref.id))h.focus=focused.get(r.ref.id);h.cursorAfter=cursor(key,start+i+1);return h;}), ...(start+selected.length<records.length?{nextCursor:cursor(key,start+selected.length)}:{}),warnings,observedAt:now(),retrieval:{requestedMode:q.mode,effectiveMode:q.mode} };
}
export async function readQmd(c: Config, ref: Ref): Promise<RecordData> {
  const origin=(await originalPaths(c)).get(ref.id);
  const db=open(c);let row: Indexed;
  try { row=indexed(c,db,ref.id,origin?.path); } finally { db.close(); }
  if(ref.version && ref.version!==row.hash)fail("STALE_RECORD","QMD index changed; search again");
  if(!origin)fail("STALE_RECORD","Original QMD file is no longer present");
  const locator=await contained(origin.root,origin.path), body=await textFile(locator);
  if(hash(body)!==row.hash)fail("STALE_RECORD","Original changed since QMD indexing; refresh the index before citing it");
  return {ref:{...ref,version:row.hash},title:row.title,body,type:"vault-document",locator,observedAt:now(),metadata:{collection:row.collection,indexedContentHash:row.hash},warnings:["QMD index is a snapshot; this read verified it against the original Markdown file. Source dates are not inferred from file modification times."]};
}
