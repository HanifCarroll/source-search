import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {qmdIndex,qmdResults} from '../src/vendor/qmd';
import {installSearchRevision} from '../src/vendor/qmd/revisions';

test('QMD schema adapter preserves selection, versions and model checks without changing the index',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-qmd-contract-')),path=join(root,'index.sqlite');
 try{
  const db=new Database(path);
  db.exec(`CREATE TABLE documents(collection TEXT,path TEXT,title TEXT,hash TEXT,active INTEGER);
    CREATE TABLE content(hash TEXT,doc TEXT);CREATE TABLE content_vectors(hash TEXT,model TEXT,embed_fingerprint TEXT);
    CREATE TABLE vectors_vec(id INTEGER);
    INSERT INTO documents VALUES('selected','Literal Name.md','Invented','one',1),('selected','old.md','Removed','gone',0),('private','secret.md','Hidden','two',1);
    INSERT INTO content VALUES('one','Invented text'),('two','Other text');
    INSERT INTO content_vectors VALUES('one','current','fingerprint'),('two','other','');`);
  installSearchRevision(db);db.close();const before=await readFile(path),index=qmdIndex(path);
  try{
   expect(index.inventory(['selected'])).toEqual([{collection:'selected',path:'Literal Name.md',hash:'one'}]);
   expect(index.inventory([])).toEqual([]);
   expect(index.collections(['selected'])).toEqual([{collection:'selected',indexedDocuments:1,ready:1,pending:0}]);
   expect(index.document('selected','Literal Name.md')).toMatchObject({hash:'one',doc:'Invented text'});
   expect(index.documentHash('selected','old.md')).toBeUndefined();
   expect(index.documentHash('selected','secret.md')).toBeUndefined();
   expect(index.hasVectorIndex()).toBe(true);expect(index.revision()).toBe(0);
   expect(()=>index.assertEmbeddingModel(['selected'],'current')).not.toThrow();
   expect(()=>index.assertEmbeddingModel(['private'],'current')).toThrow('different model');
  }finally{index.close();}
  expect(await readFile(path)).toEqual(before);
  expect(()=>qmdResults([{file:'qmd://selected/a.md',score:'bad'}])).toThrow('Invalid QMD');
 }finally{await rm(root,{recursive:true,force:true});}
});
