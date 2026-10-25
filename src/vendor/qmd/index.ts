import {Database} from 'bun:sqlite';
import {z} from 'zod';
import {fail} from '../../domain/identity';

const documentIdentity=z.object({collection:z.string(),path:z.string(),hash:z.string()});
const document=documentIdentity.extend({title:z.string(),doc:z.string()});
const count=z.number().int().nonnegative();
const collectionStatus=z.object({collection:z.string(),indexedDocuments:count,ready:count,pending:count});
export type IndexedDocument=z.infer<typeof document>;
const passage=z.object({start:count,end:count}).refine(p=>p.end>=p.start);
const hits=z.array(z.object({file:z.string(),score:z.number(),title:z.string().optional(),snippet:z.string().optional(),passage:passage.optional()}));
export function qmdResults(value:unknown){
  const result=hits.safeParse(value);
  if(!result.success)fail('INVALID_PROVIDER_RESPONSE','Invalid QMD search results');
  return result.data;
}

// All read-side knowledge of the pinned QMD schema lives here. No SDK import,
// model initialization or SQL mutation is available through this interface.
export function qmdIndex(path:string){
  // macOS SQLite may need to recreate WAL/SHM files for an existing cache.
  // query_only prevents database writes while allowing those auxiliary files.
  const db=new Database(path,{create:false,strict:true});
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10000');
  const marks=(names:readonly string[])=>names.map(()=>'?').join(',');
  return {
    close:()=>db.close(),
    inventory(collections:readonly string[]){
      if(!collections.length)return [];
      return z.array(documentIdentity).parse(db.query(`SELECT collection,path,hash FROM documents WHERE active=1 AND collection IN (${marks(collections)})`).all(...collections));
    },
    collections(collections:readonly string[]){
      if(!collections.length)return [];
      return z.array(collectionStatus).parse(db.query(`SELECT collection,count(*) indexedDocuments,
        sum(EXISTS(SELECT 1 FROM content_vectors v WHERE v.hash=d.hash)) ready,
        sum(NOT EXISTS(SELECT 1 FROM content_vectors v WHERE v.hash=d.hash)) pending
        FROM documents d WHERE active=1 AND collection IN (${marks(collections)}) GROUP BY collection`).all(...collections));
    },
    hasVectorIndex(){return !!db.query("SELECT 1 FROM sqlite_master WHERE name='vectors_vec'").get();},
    document(collection:string,path:string):IndexedDocument|undefined{
      const row=db.query('SELECT d.collection,d.path,d.title,d.hash,c.doc FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1 AND d.collection=? AND d.path=?').get(collection,path);
      return row?document.parse(row):undefined;
    },
    documentHash(collection:string,path:string):string|undefined{
      const row=db.query('SELECT hash FROM documents WHERE active=1 AND collection=? AND path=?').get(collection,path);
      return row?z.object({hash:z.string()}).parse(row).hash:undefined;
    },
    assertEmbeddingModel(collections:readonly string[],model:string){
      if(!collections.length)fail('SOURCE_NOT_CONFIGURED','No enabled search collections');
      const columns=db.query('PRAGMA table_info(content_vectors)').all() as {name:string}[];
      if(!columns.some(column=>column.name==='embed_fingerprint'))
        fail('SOURCE_NOT_READY','This index needs migration to the bundled SDK; run index --embed');
      const incompatible=db.query(`SELECT 1 FROM content_vectors v JOIN documents d ON d.hash=v.hash
        WHERE d.active=1 AND d.collection IN (${marks(collections)}) AND (v.model!=? OR v.embed_fingerprint='') LIMIT 1`).get(...collections,model);
      if(incompatible)fail('SOURCE_NOT_READY','Index vectors use a different model or an older format; complete index --embed before semantic search');
    },
    revision():number|undefined{
      if(!db.query("SELECT 1 FROM sqlite_master WHERE name='source_search_revision'").get())return;
      return z.object({revision:count}).parse(db.query('SELECT revision FROM source_search_revision WHERE id=1').get()).revision;
    },
  };
}
export type QmdIndex=ReturnType<typeof qmdIndex>;
