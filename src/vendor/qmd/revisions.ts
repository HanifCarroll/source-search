import {Database} from 'bun:sqlite';

// Explicit maintenance only. Searches read the revision through qmdIndex.
export function installSearchRevision(db:{exec(sql:string):unknown}) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_search_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO source_search_revision VALUES(1,0);`);
  for(const table of ['documents','content_vectors'])for(const event of ['INSERT','UPDATE','DELETE']) {
    // A touched timestamp is not a content change. Vector writes always count.
    const when=event==='UPDATE' && table==='documents' ? 'WHEN old.hash IS NOT new.hash OR old.active IS NOT new.active OR old.title IS NOT new.title OR old.collection IS NOT new.collection OR old.path IS NOT new.path' : '';
    db.exec(`CREATE TRIGGER IF NOT EXISTS source_search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} ${when} BEGIN UPDATE source_search_revision SET revision=revision+1 WHERE id=1; END;`);
  }
}
export function trackIndexRevision(path:string){
  const db=new Database(path,{create:false,strict:true});
  try{installSearchRevision(db);}finally{db.close();}
}
