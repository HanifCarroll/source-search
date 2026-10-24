import {googleTasksProvider} from './google-tasks';
import {sourceToken} from '../../platform/source-auth';
import {providerHttp} from '../../platform/http';
import {snapshotStore,scopedProvider} from '../sync/cache';
import {z} from 'zod';
import {sourceScope,requireSource,type Config} from '../../platform/config';
import {textFile} from '../../platform/source-files';
import {fail} from '../../domain/identity';
import type {Query,Ref} from '../../domain/contracts';
import {taskSchema,taskRecord,type TaskProvider,type TaskSnapshot} from './model';
import {taskHttp} from './http';
import {todoistProvider} from './todoist';
import {ticktickProvider} from './ticktick';
import {thingsRecords} from './things';
import {appleRemindersProvider} from './apple-reminders';
import {microsoftTodoProvider,graphOrigin} from './microsoft-todo';
import {helper} from '../local/pim';

export function taskProvider(c:Config,source:string):TaskProvider {
  requireSource(c,source);
  const s=c.sources[source];
  if(s?.adapter!=='tasks')return fail('SOURCE_NOT_CONFIGURED','Configure a tasks source and its connector');
  const connector=s.connector;
  const scope=sourceScope(c,source);
  const bind=(provider:TaskProvider)=>scopedProvider(provider,scope);
  if(connector.type==='google-tasks'){
    return bind(googleTasksProvider(source,connector.lists,providerHttp('https://tasks.googleapis.com/tasks/v1',{token:sourceToken(c,source)}).json));
  }
  if(connector.type==='todoist')return bind(todoistProvider(source,taskHttp('https://api.todoist.com/api/v1',connector.token,'form')));
  if(connector.type==='ticktick')return bind(ticktickProvider(source,connector.projects,taskHttp('https://api.ticktick.com/open/v1',connector.token)));
  if(connector.type==='apple-reminders')return bind(appleRemindersProvider(source,connector.lists,args=>{
    if(process.platform!=='darwin')return fail('UNSUPPORTED_PLATFORM','Apple Reminders requires macOS');
    return helper({...c,pimHelper:connector.helper||c.pimHelper,pimLauncher:connector.launcher||c.pimLauncher},args,32*1024*1024);
  }));
  if(connector.type==='microsoft-todo'){
    const token=sourceToken(c,source);
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
    const records:TaskSnapshot['records']=[],ids=new Set<string>();let bytes=0;
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

export type {SourceCache as TaskCache} from '../sync/cache';
export const taskCachePath=(c:Config,source:string)=>snapshotStore(c,source,'task-snapshots').path;
export const taskCache=(c:Config,source:string)=>snapshotStore(c,source,'task-snapshots').read();
export const taskStatus=(c:Config,source:string)=>snapshotStore(c,source,'task-snapshots').status();
export const searchTasks=(c:Config,q:Query)=>snapshotStore(c,q.source,'task-snapshots').search(q);
export const readTask=(c:Config,ref:Ref)=>snapshotStore(c,ref.source,'task-snapshots').original(ref,taskProvider(c,ref.source));
