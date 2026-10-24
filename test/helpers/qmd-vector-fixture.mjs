// Run in its own process so QMD can select an extension-capable SQLite library.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,Maintenance} from '@tobilu/qmd';

const dir=await mkdtemp(join(tmpdir(),'ss-vector-'));
const store=await createStore({dbPath:join(dir,'index.sqlite'),config:{collections:{notes:{path:dir},other:{path:dir},large:{path:dir},excluded:{path:dir}}}});
try {
  const db=store.internal.db;
  store.internal.ensureVecTable(4);
  const content=db.prepare('INSERT INTO content(hash,doc,created_at) VALUES(?,?,?)');
  const document=db.prepare('INSERT INTO documents(collection,path,title,hash,created_at,modified_at,active) VALUES(?,?,?,?,?,?,?)');
  const metadata=db.prepare('INSERT INTO content_vectors(hash,seq,pos,model,embed_fingerprint,total_chunks,embedded_at) VALUES(?,0,0,?,?,1,?)');
  const vector=db.prepare('INSERT INTO vectors_vec(hash_seq,embedding) VALUES(?,?)');
  const stamp='2026-01-01T00:00:00Z';
  function insert(id,collection,angle,active=1) {
    content.run(id,'Invented document '+id,stamp);
    document.run(collection,id+'.md',id,id,stamp,stamp,active);
    metadata.run(id,'fixture','fixture',stamp);
    vector.run(id+'_0',new Float32Array([Math.cos(angle),Math.sin(angle),0,0]));
  }
  db.exec('BEGIN');
  // More than three old 400-key batches. Excluded documents are closer than
  // every allowed document, so a global search followed by filtering fails.
  for(let i=0;i<1201;i++)insert('note-'+i,'notes',0.2+i*0.0002);
  for(let i=0;i<2000;i++)insert('excluded-'+i,'excluded',0.001+i*0.00001);
  insert('other-note','other',0.5);
  insert('large-target','large',0.6);
  insert('large-body','large',1);
  const largeMetadata=db.prepare('INSERT INTO content_vectors(hash,seq,pos,model,embed_fingerprint,total_chunks,embedded_at) VALUES(?,?,0,?,?,20001,?)');
  for(let seq=1;seq<=20000;seq++){
    largeMetadata.run('large-body',seq,'fixture','fixture',stamp);
    vector.run('large-body_'+seq,new Float32Array([Math.cos(1),Math.sin(1),0,0]));
  }
  insert('inactive','notes',0,0);
  document.run('excluded','shared.md','shared','note-0',stamp,stamp,1);
  db.exec('COMMIT');

  // Only inference is replaced; exercise the installed SDK and real sqlite-vec.
  const embedding=[1,0,0,0];
  store.internal.llm.embed=async()=>({embedding});
  store.internal.llm.embedBatch=async texts=>texts.map(()=>({embedding}));
  store.internal.llm.rerank=async(_query,docs)=>({results:docs.map((doc,index)=>({file:doc.file,score:0.5,index})),model:'fixture'});
  let vectorLookups=0;
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{
    const statement=prepare(sql);
    if(!/FROM\s+vectors_vec\b/i.test(sql))return statement;
    return new Proxy(statement,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(typeof value!=='function')return value;
      return (...args)=>{if(key==='all'||key==='get')vectorLookups++;return value.apply(target,args);};
    }});
  };
  const hits=await store.searchVector('invented query',{collection:'notes',limit:3});
  assert.deepEqual(hits.map(hit=>hit.filepath),[0,1,2].map(i=>'qmd://notes/note-'+i+'.md'));
  assert.equal(hits[0].score,1-db.prepare('SELECT vec_distance_cosine(?,?) AS d').get(new Float32Array(embedding),new Float32Array([Math.cos(0.2),Math.sin(0.2),0,0])).d);
  // One shared lookup, plus one scoped retry if excluded vectors are closer.
  // Work must not grow into repeated whole-index passes with each collection.
  assert.ok(vectorLookups<=2,`One collection caused ${vectorLookups} vector lookups`);
  vectorLookups=0;
  store.internal.expandQuery=async()=>[];
  const hybrid=await store.search({query:'invented query',collections:['notes','other'],limit:10,chunkStrategy:'regex'});
  assert.equal(hybrid.length,10);
  assert.ok(hybrid.every(hit=>hit.file.startsWith('qmd://notes/')||hit.file.startsWith('qmd://other/')));
  assert.ok(hybrid.some(hit=>hit.file==='qmd://notes/note-0.md'));
  assert.ok(vectorLookups<=2,`Two collections caused ${vectorLookups} vector lookups`);
  // Shared lookup must agree with independently searching each collection.
  const individual=await Promise.all(['notes','other'].map(collection=>store.searchVector('invented query',{collection,limit:10})));
  const expected=individual.flat().sort((a,b)=>b.score-a.score).slice(0,10);
  const together=await store.searchVector('invented query',{collection:['notes','other'],limit:10});
  assert.deepEqual(together,expected);
  // A tie at the document limit must keep the original collection-order merge.
  for(let i=0;i<8;i++){insert('tie-note-'+i,'notes',0.0001);insert('tie-other-'+i,'other',0.0001);}
  const tiedSeparate=(await Promise.all(['other','notes'].map(collection=>store.searchVector('invented query',{collection,limit:5})))).flat().sort((a,b)=>b.score-a.score).slice(0,5);
  assert.deepEqual(await store.searchVector('invented query',{collection:['other','notes'],limit:5}),tiedSeparate);
  db.exec("DELETE FROM documents WHERE path LIKE 'tie-%'; DELETE FROM vectors_vec WHERE hash_seq LIKE 'tie-%'; DELETE FROM content_vectors WHERE hash LIKE 'tie-%'; DELETE FROM content WHERE hash LIKE 'tie-%'");
  // Thousands of chunks from one document can occupy the global nearest set.
  // Fall back to per-collection retrieval instead of dropping the other sources.
  const crowded=await store.searchVector('invented query',{collection:['large','other'],limit:3});
  const crowdedSeparate=(await Promise.all(['large','other'].map(collection=>store.searchVector('invented query',{collection,limit:3})))).flat().sort((a,b)=>b.score-a.score).slice(0,3);
  assert.deepEqual(crowded,crowdedSeparate);
  // The old large-collection fallback selected global neighbors first, letting
  // closer excluded records hide every result in the requested collection.
  vectorLookups=0;
  const large=await store.searchVector('invented query',{collection:'large',limit:3});
  assert.deepEqual(large.map(hit=>hit.filepath),['qmd://large/large-target.md','qmd://large/large-body.md']);
  assert.ok(vectorLookups<=2);
  assert.deepEqual(await store.searchVector('invented query',{collection:'missing',limit:3}),[]);
  vectorLookups=0;
  const all=await store.searchVector('invented query',{collection:['notes','other','large','excluded'],limit:3});
  assert.equal(all.length,3);
  // The inactive closest vector forces the scoped fallback even when all
  // collection names are included. It must never leak into the result.
  assert.ok(all.every(hit=>!hit.filepath.endsWith('/inactive.md')));
  const active=db.prepare('SELECT count(*) n FROM documents WHERE active=1').get().n;
  const maintenance=new Maintenance(store.internal);
  assert.equal(maintenance.cleanupOrphanedVectors(),1);
  assert.equal(maintenance.deleteInactiveDocs(),1);
  assert.equal(maintenance.cleanupOrphanedContent(),1);
  assert.equal(db.prepare('SELECT count(*) n FROM documents WHERE active=1').get().n,active);
  assert.deepEqual((await store.searchVector('invented query',{collection:'notes',limit:3})).map(hit=>hit.filepath),hits.map(hit=>hit.filepath));
  console.log(JSON.stringify({semantic:hits.length,hybrid:hybrid.length,vectorLookups}));
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
