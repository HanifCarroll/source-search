import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '@tobilu/qmd';
import {prepareInferenceCache} from '../../src/search/qmd/sdk.mjs';

const root=await mkdtemp(join(tmpdir(),'ss-inference-cache-'));
let store;
let scored=0,expanded=0;
async function open(model='invented-ranker-v1') {
  const s=await createStore({dbPath:join(root,'index.sqlite'),config:{collections:{notes:{path:root,pattern:'*.md'}},models:{rerank:model}}});
  s.internal.llm.expandQuery=async()=>{expanded++;return [{type:'lex',text:'invented'}];};
  s.internal.llm.rerank=async(_query,docs)=>{
    scored+=docs.length;
    return {results:docs.map((d,index)=>({file:d.file,index,score:d.text.includes('changed')?0.4:0.8})),model};
  };
  return s;
}
const search=()=>store.search({query:'invented project',collections:['notes'],limit:10,chunkStrategy:'regex'});
try {
  for(const id of ['one','two','three'])await writeFile(join(root,id+'.md'),`# Invented project ${id}\nDetails for ${id}.`);
  store=await open();await store.update();prepareInferenceCache(store.internal.db,'model-file-revision-1');
  const first=await search();assert.equal(first.length,3);assert.equal(scored,3);
  const initialExpanded=expanded;
  await writeFile(join(root,'two.md'),'# Invented project two\nThe details changed.');
  await store.update();
  const updated=await search();assert.equal(updated.length,3);
  assert.equal(scored,4,'An edit must score only its changed text, not every unchanged candidate');
  assert.equal(expanded,initialExpanded,'Content updates must not discard query/model-keyed expansions');
  assert.ok(updated.find(r=>r.file.endsWith('/two.md')).body.includes('changed'));
  await rm(join(root,'three.md'));await store.update();
  assert.equal((await search()).length,2);assert.equal(scored,4);
  await store.close();store=await open('invented-ranker-v2');
  await search();assert.equal(scored,6,'A different model must not reuse prior scores');
  prepareInferenceCache(store.internal.db,'model-file-revision-1');
  await search();assert.equal(scored,6,'An unchanged model revision must keep cached scores');
  prepareInferenceCache(store.internal.db,'model-file-revision-2');
  await search();assert.equal(scored,8,'Replacing weights at the same path must invalidate inference');
  store.internal.clearCache();await search();assert.equal(scored,10,'Explicit cache clearing must still work');
  console.log(JSON.stringify({scored,expanded}));
} finally {await store?.close();await rm(root,{recursive:true,force:true});}
