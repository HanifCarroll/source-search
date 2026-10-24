import {z} from 'zod';
import {versioned,now,fail} from '../../domain/identity';
import type {RecordData} from '../../domain/contracts';

const id=z.string().min(1).max(500);
const timestamp=z.iso.datetime({offset:true});
export const taskSchema=z.object({
  id,title:z.string().min(1).max(10000),description:z.string().max(500000).default(''),
  status:z.enum(['open','completed','canceled']).default('open'),
  project:z.object({id,name:z.string()}).optional(),parentId:id.optional(),section:z.string().optional(),
  labels:z.array(z.string()).max(1000).default([]),priority:z.string().optional(),
  createdAt:timestamp.optional(),completedAt:timestamp.optional(),due:z.string().optional(),deadline:z.string().optional(),
  recurrence:z.string().optional(),comments:z.array(z.string()).max(10000).default([]),
  checklist:z.array(z.object({title:z.string(),completed:z.boolean()})).max(10000).default([]),
}).strict();
export type Task=z.infer<typeof taskSchema>;
export function taskRecord(source:string,provider:string,task:Task,locator:string):RecordData{
  const body=[task.title,`Status: ${task.status}`,task.project&&`Project: ${task.project.name}`,
    task.section&&`Section: ${task.section}`,task.parentId&&`Parent task: ${task.parentId}`,
    task.labels.length&&`Labels: ${task.labels.join(', ')}`,task.priority&&`Priority: ${task.priority}`,
    task.due&&`Due: ${task.due}`,task.deadline&&`Deadline: ${task.deadline}`,task.recurrence&&`Repeats: ${task.recurrence}`,
    task.description,...task.checklist.map(i=>`[${i.completed?'x':' '}] ${i.title}`),...task.comments.map(t=>'Comment: '+t)].filter(Boolean).join('\n\n');
  return versioned({adapter:'tasks',ref:{source,id:task.id},title:task.title,body,type:'task',locator,observedAt:now(),
    occurredAt:task.createdAt,metadata:{provider,task,dateKind:'created'}});
}
export function checkedTask(value:unknown){const parsed=taskSchema.safeParse(value);if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Task data does not match the supported format');return parsed.data;}
export type {SourceSnapshot as TaskSnapshot,SourceProvider as TaskProvider} from '../sync/model';
