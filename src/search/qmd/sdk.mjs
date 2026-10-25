// Isolated SDK process: bounds native model lifetime and keeps diagnostics off MCP stdout.
export function prepareInferenceCache(db, revision) {
  if(!revision)return;
  db.exec('CREATE TABLE IF NOT EXISTS source_search_maintenance(key TEXT PRIMARY KEY,value TEXT)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous=db.prepare("SELECT value FROM source_search_maintenance WHERE key='inference-revision'").get();
    if(previous?.value!==revision){
      // Content changes have their own keys; replaced model files do not.
      db.exec('DELETE FROM llm_cache');
      db.prepare("INSERT OR REPLACE INTO source_search_maintenance VALUES('inference-revision',?)").run(revision);
    }
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
export async function main() {
  process.umask(0o077);
  let input='';for await(const data of process.stdin){input+=data;if(input.length>256*1024)throw Error('Search configuration exceeds budget');}
  const request=JSON.parse(input);
  const {createStore,extractSnippet,Maintenance}=await import(request.sdkUrl);
  const store=await createStore({dbPath:request.database,config:{collections:request.collections,models:request.models}});
  try {
    if(!request.action && request.mode!=='lexical')prepareInferenceCache(store.internal.db,request.inferenceRevision);
    let result;
    if(request.action==='update'){
      const db=store.internal.db;
      db.exec('CREATE TABLE IF NOT EXISTS source_search_maintenance(key TEXT PRIMARY KEY,value TEXT)');
      const previous=db.prepare("SELECT value FROM source_search_maintenance WHERE key='projection-signature'").get();
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
    }
    else if(request.action==='embed'){
      result={docsProcessed:0,chunksEmbedded:0,errors:0};let logged=0;
      for(const collection of Object.keys(request.collections)){
        const batch=await store.embed({collection,chunkStrategy:'regex',maxDocsPerBatch:32,maxBatchBytes:8*1024*1024,model:request.models.embed,onProgress:p=>{if(Date.now()-logged>2000){console.error(JSON.stringify({collection,progress:p}));logged=Date.now();}}});
        result.docsProcessed+=batch.docsProcessed;result.chunksEmbedded+=batch.chunksEmbedded;result.errors+=batch.errors;
      }
      if(result.errors)throw Error(`${result.errors} embedding chunks failed; rerun index --embed to retry`);
    }
    else if(request.action==='status')result=await store.getStatus();
    else {
      const collections=request.collection?[request.collection]:Object.keys(request.collections);
      if(!collections.length)throw Error('No enabled search collections');
      const options={limit:100,collection:collections};
      const hits=request.mode==='lexical'?await store.searchLex(request.query,options):request.mode==='semantic'?await store.searchVector(request.query,options):await store.search({query:request.query,collections,limit:100,candidateLimit:40,chunkStrategy:'regex'});
      result=hits.map(r=>({file:r.file||r.filepath,score:r.score,title:r.title,snippet:extractSnippet(r.body||'',request.query,500).snippet}));
    }
    console.log('SOURCE_SEARCH_RESULT '+JSON.stringify(result));
  } finally {await store.close();}
}
