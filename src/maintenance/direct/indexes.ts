import {Database} from 'bun:sqlite';
import {qmdIndex} from '../../vendor/qmd';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {hash,fail} from '../../domain/identity';
import type {Ref} from '../../domain/contracts';
import type {ObservedProjection} from '../../domain/observations';
import {sourceKind} from '../../domain/source-catalog';
import {sourceConfig,sourceScope} from '../../platform/config';
import {regular} from '../../platform/source-files';
import {sourceFiles} from '../../sources/local/notes';
import {archiveSignature,exportPaths,exportProjectionVersion,type ArchiveSource} from '../../sources/archives/originals';
import {indexStatus,rebuildArchive} from '../../sources/archives';
import {archiveConfig} from '../archives';
import {state,stamped,type Reader} from './model';

export const archive:Reader=async(c,source,previous)=>{
 const kind=sourceKind(source,c) as ArchiveSource,scoped=source===kind?c:archiveConfig(c,source),paths:string[]=[];
 if(!exportPaths(scoped,kind).length)fail('SOURCE_NOT_CONFIGURED','Select an archive export');
 for(const path of exportPaths(scoped,kind)){
  if((await lstat(path)).isDirectory())paths.push(...(await sourceFiles(path,()=>true)).paths.map(p=>join(path,p)));
  else paths.push(path,path+'-wal');
 }
 let projection:ObservedProjection|undefined=previous?.state.projection;
 const scan=await stamped(paths,projection?previous:undefined,{...state('changed-export-inventory','Selected exported records only; no automatic account export'),generation:String(exportProjectionVersion(kind))},async()=>{
  const signature=await archiveSignature(c,source);let saved:any;
  try{saved=JSON.parse((await indexStatus(scoped))[kind]||'{}');}catch(e){if(!['ENOENT','INDEX_NOT_READY'].includes((e as any).code))throw e;}
  if(saved?.signature!==signature||saved?.projectionVersion!==exportProjectionVersion(kind))await rebuildArchive(scoped);
  const db=new Database(scoped.index,{readonly:true});
  try{return db.transaction(()=>{
   const entries=(db.query("SELECT json_extract(data,'$.ref') ref FROM records WHERE source=? ORDER BY id").all(kind) as {ref:string}[]).map(row=>{const ref=JSON.parse(row.ref) as Ref;return {ref:{...ref,source},signature:ref.version!};});
   projection={kind:'archive',revision:signature,scope:sourceScope(c,source),version:exportProjectionVersion(kind),guard:{archive:source,signature}};
   return entries;
  })();}finally{db.close();}
 });
 return {...scan,state:{...scan.state,projection}};
};
export const vault:Reader=async(c,source)=>{
 const scoped=sourceConfig(c,source),collections=Object.keys(scoped.qmdRoots);
 if(!collections.length)fail('SOURCE_NOT_CONFIGURED','Select QMD collections');
 await regular(scoped.qmdDatabase);
 // Same selected, active document inventory used by the QMD reader. This
 // observes committed index revisions without running ranking or embeddings.
 const index=qmdIndex(scoped.qmdDatabase);
 try{return {
  entries:index.inventory(collections).map(r=>({ref:{source,id:`qmd://${r.collection}/${r.path}`,version:r.hash},signature:r.hash})),
  state:state('indexed-document-fingerprints','Active documents in selected QMD collections; index refresh controls freshness and original reads verify file content'),
 };}finally{index.close();}
};
// data_version identifies the parser format, not an archive generation.
// The newest session cannot detect edits or removals of older sessions.
export const agentHistory:Reader=async()=>{
 fail('UNSUPPORTED_CHANGE_TRACKING','AgentsView v0.46.1 exposes no reliable whole-index generation. Agent-history tracking needs index granularity: a reset means rerun relevant searches; newest-session sampling cannot guarantee that.');
};
