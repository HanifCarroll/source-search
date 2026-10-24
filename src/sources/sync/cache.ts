import {join} from 'node:path';
import {sourceScope,requireSource,type Config} from '../../platform/config';
import {textFile} from '../../platform/source-files';
import {recordPage} from '../../domain/pages';
import {assertVersion,fail,hash} from '../../domain/identity';
import type {Query,Ref} from '../../domain/contracts';
import type {SourceSnapshot,SourceProvider} from './model';

export type SourceCache=SourceSnapshot & {version:1;scope:string;checkedAt:string;lastError?:{code:string;message:string};lastAttemptAt?:string};
export function snapshotStore(c:Config,source:string,namespace:'task-snapshots'|'source-snapshots'='source-snapshots'){
  const command=namespace==='task-snapshots'?'sync-tasks':'sync-sources';
  const path=join(c.libraryRoot,namespace,hash(source)+'.json');
  async function read():Promise<SourceCache|undefined>{
    requireSource(c,source);let raw:string;
    try{raw=await textFile(path,128*1024*1024);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    const saved=JSON.parse(raw) as SourceCache;
    if(saved.version!==1||saved.scope!==sourceScope(c,source))fail('STALE_INDEX',`Connection changed; run ${command} to refresh it`);
    if(!Array.isArray(saved.records))fail('INVALID_CACHE',`Snapshot is invalid; run ${command} to refresh it`);
    return saved;
  }
  return {path,read,
    async status(){const saved=await read();return {available:!!saved,state:saved?.lastError?'error':undefined,records:saved?.records.length,coverage:saved?.coverage,checkedAt:saved?.checkedAt,syncStrategy:saved?.strategy,
      filters:['from','to','types'],warnings:saved?.warnings||[],...(saved?.lastError?{error:saved.lastError}:!saved?{error:{code:'NEEDS_SYNC',message:`Run source-search ${command} to load the selected source`}}:{})};},
    async search(q:Query){const saved=await read();if(!saved)fail('NEEDS_SYNC',`Run source-search ${command} before searching this source`);return recordPage(saved.records,q,[...saved.warnings,...(saved.coverageWindow&&((q.from&&Date.parse(q.from)<Date.parse(saved.coverageWindow.from))||(q.to&&Date.parse(q.to)>Date.parse(saved.coverageWindow.to)))?['Calendar snapshot covers '+saved.coverageWindow.from+' to '+saved.coverageWindow.to+'; widen the configured window and sync to search outside it']:[]),...(saved.lastError?['Using the last successful snapshot; latest sync failed: '+saved.lastError.code]:[])]);},
    async original(ref:Ref,provider:SourceProvider){const saved=await read(),record=await provider.read(ref.id,saved?.checkpoint);assertVersion(ref,record.ref.version!);return record;},
  };
}
export function scopedProvider(provider:SourceProvider,scope:string):SourceProvider{
  const bind=(r:SourceSnapshot['records'][number])=>({...r,ref:{...r.ref,version:hash(r.ref.version+scope)}});
  return {...provider,async sync(previous){const snapshot=await provider.sync(previous);return {...snapshot,records:snapshot.records.map(bind)};},async read(id,previous){return bind(await provider.read(id,previous));}};
}
