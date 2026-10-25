import {privateDirectory} from '../../platform/storage';
import {randomUUID} from 'node:crypto';
import {writeFile,rename,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {sourceScope,type Config} from '../../platform/config';
import {now,stableJson} from '../../domain/identity';
import type {RecordData} from '../../domain/contracts';
import {cacheDB as libraryDB,getState,setState} from '../../platform/cache-db';
import {makeChunks,searchProjectionVersion,type Chunk} from './projection';
export {cacheDB as libraryDB,getState,setState} from '../../platform/cache-db';
export {makeChunks,searchProjectionVersion,type Chunk} from './projection';

export async function publish(c:Config,source:string,records:RecordData[],guard:unknown,extra:Record<string,unknown>={}){
  guard={...(guard as object),scope:sourceScope(c,source)};
  const chunks=makeChunks(source,records,guard),folder=join(c.libraryRoot,'collections','ss-'+source);
  await privateDirectory(c.libraryRoot);await privateDirectory(folder);
  const db=libraryDB(c,true);
  try{
    const old=new Map((db.query('SELECT c.*,s.hash AS searchHash FROM chunks c LEFT JOIN chunk_search s ON s.id=c.id WHERE c.source=?').all(source) as any[]).map(row=>[row.id,row]));
    const changed:Chunk[]=[];let next=0;
    await Promise.all(Array.from({length:16},async()=>{while(next<chunks.length){
      const chunk=chunks[next++]!,previous=old.get(chunk.id);
      if(previous?.searchHash!==chunk.searchHash){
        const path=join(folder,chunk.id+'.md');
        await writeFile(path+'.tmp',chunk.searchText,{mode:0o600});await rename(path+'.tmp',path);
      }
      if(!previous||previous.searchHash!==chunk.searchHash||previous.hash!==chunk.hash||previous.body!==chunk.body||previous.refs!==JSON.stringify(chunk.refs)||stableJson(JSON.parse(previous.guard))!==stableJson(chunk.guard))changed.push(chunk);
      old.delete(chunk.id);
    }}));
    // Files precede the manifest commit. Search checks the indexed search hash;
    // saved references continue to check the unchanged canonical content hash.
    db.transaction(()=>{
      for(const id of old.keys()){db.query('DELETE FROM chunk_search WHERE id=?').run(id);db.query('DELETE FROM chunks WHERE id=? AND source=?').run(id,source);}
      const canonical=db.query('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?,?)');
      const search=db.query('INSERT OR REPLACE INTO chunk_search VALUES(?,?,?)');
      for(const chunk of changed){
        canonical.run(chunk.id,chunk.source,chunk.title,chunk.body,chunk.hash,JSON.stringify(chunk.refs),JSON.stringify(chunk.guard));
        search.run(chunk.id,chunk.searchHash,JSON.stringify(chunk.searchSpans));
      }
      const previous=getState(db,source),edited=changed.length||old.size;
      setState(db,source,{...previous,...extra,records:records.length,textRecords:records.filter(r=>r.body.trim()).length,chunks:chunks.length,searchVersion:searchProjectionVersion,publishedAt:edited?now():previous.publishedAt||now(),projectionRevision:edited?randomUUID():previous.projectionRevision||randomUUID(),guard});
    })();
    const live=new Set(chunks.map(chunk=>chunk.id+'.md'));
    for(const name of await readdir(folder))if(/^[a-f0-9]{64}\.md(?:\.tmp)?$/.test(name)&&!live.has(name))await rm(join(folder,name),{force:true});
  }finally{db.close();}
  return chunks.length;
}
