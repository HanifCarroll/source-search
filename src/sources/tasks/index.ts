import {z} from 'zod';
import {join} from 'node:path';
import {sourceScope,requireSource,type Config} from '../../platform/config';
import {textFile} from '../../platform/source-files';
import {recordPage} from '../../domain/pages';
import {assertVersion,fail,hash} from '../../domain/identity';
import type {Query,Ref,RecordData} from '../../domain/contracts';
import {taskSchema,taskRecord,type TaskProvider,type TaskSnapshot} from './model';
import {taskHttp} from './http';
import {todoistProvider} from './todoist';
import {ticktickProvider} from './ticktick';
import {thingsRecords} from './things';
import {appleRemindersProvider} from './apple-reminders';
import {microsoftTodoProvider,graphOrigin} from './microsoft-todo';
import {microsoftToken} from '../../platform/microsoft-auth';
import {helper} from '../local/pim';

export function taskProvider(c:Config,source:string):TaskProvider {
  requireSource(c,source);
  const s=c.sources[source];
  if(s?.adapter!=='tasks')return fail('SOURCE_NOT_CONFIGURED','Configure a tasks source and its connector');
  const connector=s.connector;
  const scope=sourceScope(c,source);
  const bindRecord=(r:RecordData)=>({...r,ref:{...r.ref,version:hash(r.ref.version+scope)}});
  const bind=(provider:TaskProvider):TaskProvider=>({...provider,sync:async previous=>{const snapshot=await provider.sync(previous);return {...snapshot,records:snapshot.records.map(bindRecord)};},read:async(id,previous)=>bindRecord(await provider.read(id,previous))});
  if(connector.type==='todoist')return bind(todoistProvider(source,taskHttp('https://api.todoist.com/api/v1',connector.token,'form')));
  if(connector.type==='ticktick')return bind(ticktickProvider(source,connector.projects,taskHttp('https://api.ticktick.com/open/v1',connector.token)));
  if(connector.type==='apple-reminders')return bind(appleRemindersProvider(source,connector.lists,args=>{
    if(process.platform!=='darwin')return fail('UNSUPPORTED_PLATFORM','Apple Reminders requires macOS');
    return helper({...c,pimHelper:connector.helper||c.pimHelper,pimLauncher:connector.launcher||c.pimLauncher},args,32*1024*1024);
  }));
  if(connector.type==='microsoft-todo'){
    let accessToken:Promise<string>|undefined;
    const token=connector.token||(()=>accessToken??=microsoftToken(connector.oauth!));
    return bind(microsoftTodoProvider(source,connector.lists,taskHttp(graphOrigin,token)));
  }
  async function sync():Promise<TaskSnapshot>{
    if(connector.type==='things'){
      const snapshot=await thingsRecords({...c,things:connector.root||c.things,thingsDatabase:connector.database});
      // Reuse the Things reader; its existing things-archive route and saved
      // references are unchanged. New task sources also bind their scope below.
      return {records:[...snapshot.records.values()].map(r=>({...r,adapter:'tasks',ref:{...r.ref,source}})),strategy:'snapshot-row-diff',
        coverage:'Selected Things database or export, including the statuses present in that snapshot',warnings:[]};
    }
    if(connector.type!=='json')return fail('SOURCE_NOT_CONFIGURED','Unknown task connector');
    const records:RecordData[]=[],ids=new Set<string>();let bytes=0;
    for(const path of connector.paths){
      const raw=await textFile(path,32*1024*1024);bytes+=Buffer.byteLength(raw);
      if(bytes>32*1024*1024)fail('SOURCE_LIMIT','Task files exceed 32 MiB');
      const parsed=z.object({version:z.literal(1),tasks:z.array(taskSchema).max(20000)}).strict().safeParse(JSON.parse(raw));
      if(!parsed.success)fail('INVALID_ARCHIVE','Expected a version 1 task file with a tasks array');
      for(const task of parsed.data.tasks){if(ids.has(task.id))fail('INVALID_ARCHIVE','Task IDs must be unique within the source');ids.add(task.id);}
      records.push(...parsed.data.tasks.map(task=>taskRecord(source,'json',task,path+'#'+encodeURIComponent(task.id))));
      if(records.length>20000)fail('SOURCE_LIMIT','Task source exceeds 20,000 records');
    }
    return {records,strategy:'snapshot-row-diff',coverage:'Tasks in the selected JSON files, including the statuses present in those files',warnings:[]};
  }
  return bind({sync,async read(id){const r=(await sync()).records.find(r=>r.ref.id===id);if(!r)fail('RECORD_NOT_FOUND','Task is absent from the selected files');return r;}});
}

export type TaskCache=TaskSnapshot & {version:1;scope:string;checkedAt:string;lastError?:{code:string;message:string};lastAttemptAt?:string};
export const taskCachePath=(c:Config,source:string)=>join(c.libraryRoot,'task-snapshots',hash(source)+'.json');
export async function taskCache(c:Config,source:string):Promise<TaskCache|undefined>{
  requireSource(c,source);
  let raw:string;
  try{raw=await textFile(taskCachePath(c,source),32*1024*1024);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  const saved=JSON.parse(raw) as TaskCache;
  if(saved.version!==1 || saved.scope!==sourceScope(c,source))fail('STALE_INDEX','Task connection changed; run sync-tasks to refresh it');
  if(!Array.isArray(saved.records))fail('INVALID_CACHE','Task snapshot is invalid; run sync-tasks to refresh it');
  return saved;
}
export async function taskStatus(c:Config,source:string){
  const saved=await taskCache(c,source);
  return {available:!!saved,state:saved?.lastError?'error':undefined,records:saved?.records.length,coverage:saved?.coverage,checkedAt:saved?.checkedAt,syncStrategy:saved?.strategy,
    filters:['from','to','types'],warnings:saved?.warnings||[],...(saved?.lastError?{error:saved.lastError}:!saved?{error:{code:'NEEDS_SYNC',message:'Run source-search sync-tasks to load the selected tasks'}}:{})};
}
export async function searchTasks(c:Config,q:Query){
  const saved=await taskCache(c,q.source);if(!saved)fail('NEEDS_SYNC','Run source-search sync-tasks before searching this source');
  return recordPage(saved.records,q,[...saved.warnings,...(saved.lastError?['Using the last successful task snapshot; latest sync failed: '+saved.lastError.code]:[])]);
}
export async function readTask(c:Config,ref:Ref){
  const saved=await taskCache(c,ref.source),record=await taskProvider(c,ref.source).read(ref.id,saved?.checkpoint);
  assertVersion(ref,record.ref.version!);return record;
}
