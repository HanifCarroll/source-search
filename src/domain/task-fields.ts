import {z} from 'zod';
import type {RecordData,TaskFields} from './contracts';

const date=z.iso.date(),timestamp=z.iso.datetime({offset:true,local:true});
// Task due filters compare the calendar date supplied by the provider. Date-only
// tasks never shift through UTC; timestamps retain their reported calendar day.
export function taskDueDate(value:unknown):Pick<TaskFields,'dueDate'|'invalidDueDate'>{
  if(value===undefined||value===null||value==='')return {};
  if(typeof value!=='string')return {invalidDueDate:true};
  const raw=value.replace(/ \[[^\]\r\n]+\]$/,'').replace(/([+-]\d{2})(\d{2})$/,'$1:$2');
  if(date.safeParse(raw).success||timestamp.safeParse(raw).success)return {dueDate:raw.slice(0,10)};
  return {invalidDueDate:true};
}
export function taskFields(record:RecordData):TaskFields|undefined{
  if(record.task)return record.task;
  // Old JSON snapshots contain this same normalized payload, so they can be
  // queried without changing their references or contacting an offline provider.
  const task=record.metadata?.task as {status?:unknown;due?:unknown;project?:{id?:unknown;name?:unknown}}|undefined;
  if(record.type!=='task'||!task||!['open','completed','canceled'].includes(String(task.status)))return;
  return {status:task.status as TaskFields['status'],...taskDueDate(task.due),
    ...(typeof task.project?.name==='string'?{project:{name:task.project.name,...(typeof task.project.id==='string'?{id:task.project.id}:{})}}:{})};
}
