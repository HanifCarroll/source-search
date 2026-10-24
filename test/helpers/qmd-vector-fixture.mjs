// Run in its own process so QMD can select an extension-capable SQLite library.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '@tobilu/qmd';

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
  // Work budget, not a wall-clock threshold: one vector lookup per collection
  // must not become repeated whole-index passes as that collection grows.
  assert.ok(vectorLookups<=1,`One collection caused ${vectorLookups} vector lookups`);
  vectorLookups=0;
  const hybrid=await store.search({queries:[{type:'vec',query:'invented query'}],collections:['notes','other'],limit:10,chunkStrategy:'regex'});
  assert.equal(hybrid.length,10);
  assert.ok(hybrid.every(hit=>hit.file.startsWith('qmd://notes/')||hit.file.startsWith('qmd://other/')));
  assert.ok(hybrid.some(hit=>hit.file==='qmd://notes/note-0.md'));
  assert.ok(vectorLookups<=2,`Two collections caused ${vectorLookups} vector lookups`);
  // The old large-collection fallback selected global neighbors first, letting
  // closer excluded records hide every result in the requested collection.
  vectorLookups=0;
  const large=await store.searchVector('invented query',{collection:'large',limit:3});
  assert.deepEqual(large.map(hit=>hit.filepath),['qmd://large/large-target.md','qmd://large/large-body.md']);
  assert.ok(vectorLookups<=1);
  assert.deepEqual(await store.searchVector('invented query',{collection:'missing',limit:3}),[]);
  console.log(JSON.stringify({semantic:hits.length,hybrid:hybrid.length,vectorLookups}));
} finally {await store.close();await rm(dir,{recursive:true,force:true});}
