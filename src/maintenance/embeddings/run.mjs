// QMD 1.0.7 embedding primitives, with atomic per-document batches and a time budget.
// Maintenance only. A crash cannot leave seq=0 marking an incompletely embedded document.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { embedDocuments } from './batches.mjs';
process.umask(0o077);
const home=homedir(),config=JSON.parse(readFileSync(process.env.SOURCE_SEARCH_CONFIG_FILE || join(home,'.config/source-search/config.json'),'utf8'));
if(!config.maintenanceEnabled || !config.enabledSources?.includes('library'))throw Error('Library maintenance is disabled');
const base=config.qmdPackage;if(!base || !base.startsWith('/'))throw Error('Configure an absolute qmdPackage path');
process.env.HF_HUB_OFFLINE='1';
if(JSON.parse(readFileSync(join(base,'package.json'),'utf8')).version!=='1.0.7')throw Error('Review the embedding adapter after upgrading QMD');
if(!config.qmdModels?.length || !config.qmdModels.every(existsSync))throw Error('Install QMD models explicitly before maintenance');
const {createStore,chunkDocumentByTokens,formatDocForEmbedding,extractTitle,insertEmbedding,DEFAULT_EMBED_MODEL}=await import(pathToFileURL(join(base,'dist/store.js')));
const {withLLMSession,disposeDefaultLlamaCpp}=await import(pathToFileURL(join(base,'dist/llm.js')));
const store=createStore(config.libraryDatabase),db=store.db;
let stopped=false;process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
const started=Date.now(),deadline=started+600000;let documents=0,vectors=0,lastProgress=started;
try{
 const pending=db.prepare('SELECT hash,body,path FROM (SELECT d.hash,c.doc body,d.path,d.collection,row_number() OVER (PARTITION BY d.collection ORDER BY d.id) turn FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1 AND NOT EXISTS(SELECT 1 FROM content_vectors v WHERE v.hash=d.hash AND v.seq=0)) ORDER BY turn,collection LIMIT 10000').all();
 if(pending.length)await withLLMSession(async session=>{
  ({documents,vectors}=await embedDocuments({items:pending,
   shouldStop:()=>stopped || Date.now()>deadline,
   prepare:async item=>{const chunks=await chunkDocumentByTokens(item.body),title=extractTitle(item.body,item.path);return {...item,chunks,texts:chunks.map(c=>formatDocForEmbedding(c.text,title))};},
   embed:texts=>session.embedBatch(texts),
   commit:(item,embeddings)=>{
   store.ensureVecTable(embeddings[0].embedding.length);
   db.exec('BEGIN IMMEDIATE');
   try{for(let i=0;i<item.chunks.length;i++)insertEmbedding(db,item.hash,i,item.chunks[i].pos,new Float32Array(embeddings[i].embedding),DEFAULT_EMBED_MODEL,new Date().toISOString());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
   },
   onProgress:counts=>{if(Date.now()-lastProgress>=30000){lastProgress=Date.now();console.log(JSON.stringify({state:'embedding',...counts,elapsedSeconds:(lastProgress-started)/1000,checkedAt:new Date().toISOString()}));}}
  }));
 },{maxDuration:720000});
 const left=db.prepare('SELECT count(DISTINCT d.hash) n FROM documents d WHERE d.active=1 AND NOT EXISTS(SELECT 1 FROM content_vectors v WHERE v.hash=d.hash AND v.seq=0)').get().n;
 console.log(JSON.stringify({documents,vectors,pending:left,elapsedSeconds:(Date.now()-started)/1000,checkedAt:new Date().toISOString()}));
}finally{store.close();await disposeDefaultLlamaCpp();}
