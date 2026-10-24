// Isolated SDK process: bounds native model lifetime and keeps diagnostics off MCP stdout.
export async function main() {
  process.umask(0o077);
  let input='';for await(const data of process.stdin){input+=data;if(input.length>256*1024)throw Error('Search configuration exceeds budget');}
  const request=JSON.parse(input);
  const {createStore,extractSnippet}=await import(request.sdkUrl);
  const store=await createStore({dbPath:request.database,config:{collections:request.collections,models:request.models}});
  try {
    let result;
    if(request.action==='update')result=await store.update();
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
