import {createInterface} from 'node:readline';

export function prepareInferenceCache(db, revision) {
  if(!revision)return;
  db.exec('CREATE TABLE IF NOT EXISTS source_search_maintenance(key TEXT PRIMARY KEY,value TEXT)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous=db.prepare("SELECT value FROM source_search_maintenance WHERE key='inference-revision'").get();
    if(previous?.value!==revision){
      db.exec('DELETE FROM llm_cache');
      db.prepare("INSERT OR REPLACE INTO source_search_maintenance VALUES('inference-revision',?)").run(revision);
    }
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

// One SDK session per worker identity. Models survive individual requests;
// stdin closure, cancellation, idle expiry or a new identity ends the session.
export async function openSession(initial) {
  const {createStore,extractSnippet,Maintenance}=await import(initial.sdkUrl);
  const store=await createStore({dbPath:initial.database,config:{collections:initial.collections,models:initial.models}});
  let disposeReranker,textRanker;
  async function execute(request){
    if(!request.action && request.mode!=='lexical')prepareInferenceCache(store.internal.db,request.inferenceRevision);
    if(request.action==='update'){
      const db=store.internal.db;
      db.exec('CREATE TABLE IF NOT EXISTS source_search_maintenance(key TEXT PRIMARY KEY,value TEXT)');
      const previous=db.prepare("SELECT value FROM source_search_maintenance WHERE key='projection-signature'").get();
      let result;
      if(request.projectionSignature && previous?.value===request.projectionSignature)result={collections:Object.keys(request.collections).length,indexed:0,updated:0,removed:0,skipped:0,reused:true};
      else {
        result=await store.update({collections:Object.keys(request.collections)});
        if(request.projectionSignature && !result.skipped)db.prepare("INSERT OR REPLACE INTO source_search_maintenance VALUES('projection-signature',?)").run(request.projectionSignature);
      }
      if(!result.skipped && (result.updated || result.removed || !db.prepare("SELECT 1 FROM source_search_maintenance WHERE key='cleanup-v1'").get())){
        const maintenance=new Maintenance(store.internal);
        result.cleanup={vectors:maintenance.cleanupOrphanedVectors(),documents:maintenance.deleteInactiveDocs(),content:maintenance.cleanupOrphanedContent()};
        db.prepare("INSERT OR REPLACE INTO source_search_maintenance VALUES('cleanup-v1',?)").run(new Date().toISOString());
      }
      return result;
    }
    if(request.action==='embed'){
      const result={docsProcessed:0,chunksEmbedded:0,errors:0};let logged=0;
      for(const collection of Object.keys(request.collections)){
        const batch=await store.embed({collection,chunkStrategy:'regex',maxDocsPerBatch:32,maxBatchBytes:8*1024*1024,model:request.models.embed,onProgress:p=>{if(Date.now()-logged>2000){console.error(JSON.stringify({collection,progress:p}));logged=Date.now();}}});
        result.docsProcessed+=batch.docsProcessed;result.chunksEmbedded+=batch.chunksEmbedded;result.errors+=batch.errors;
      }
      if(result.errors)throw Error(`${result.errors} embedding chunks failed; rerun index --embed to retry`);
      return result;
    }
    if(request.action==='status')return store.getStatus();
    const collections=request.collection?[request.collection]:Object.keys(request.collections);
    if(!collections.length)throw Error('No enabled search collections');
    const options={limit:100,collection:collections};
    let hits;
    if(request.mode==='lexical')hits=await store.searchLex(request.query,options);
    else if(request.mode==='semantic')hits=await store.searchVector(request.query,options);
    else {
      const useFast=request.ranker && request.depth!=='deep';
      if(useFast && !textRanker){const {createTextRanker}=await import(request.textRankerUrl);textRanker=createTextRanker(request.ranker);}
      if(!useFast && request.acceleration && !disposeReranker){
        const {configureReranker}=await import(request.rerankerUrl);
        disposeReranker=configureReranker(store.internal.llm,request.acceleration,request.models.rerank);
      }
      const {hybridSearch}=await import(request.pipelineUrl);
      // Pinned QMD internals are confined to this adapter. Reuse its maintained
      // chunking, embedding prompts and fusion instead of duplicating them.
      const primitives=await import(new URL('store.js',request.sdkUrl).href);
      hits=await hybridSearch(store,{query:request.query,plan:request.plan,depth:request.depth,collections},primitives,useFast?textRanker.rank:undefined);
    }
    return hits.map(r=>{
      const position=r.bestChunkPos??r.chunkPos,body=r.body||'',length=r.bestChunk?.length;
      return {file:r.file||r.filepath,score:r.score,title:r.title,
        snippet:extractSnippet(body,request.query,500,position,length).snippet,
        ...(position!==undefined?{passage:{start:position,end:Math.min(body.length,position+(length??3600))}}:{})};
    });
  }
  return {execute,close:async()=>{disposeReranker?.();textRanker?.close();await store.close();}};
}

export async function main() {
  process.umask(0o077);
  let session;
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  try{
    for await(const line of lines){
      if(Buffer.byteLength(line)>4*1024*1024)throw Error('Search request exceeds budget');
      const {id,input}=JSON.parse(line);
      try{
        session??=await openSession(input);
        console.log('SOURCE_SEARCH_REPLY '+JSON.stringify({id,result:await session.execute(input)}));
      }catch(error){console.log('SOURCE_SEARCH_REPLY '+JSON.stringify({id,error:String(error?.message||error)}));}
    }
  }finally{lines.close();await session?.close();}
}
