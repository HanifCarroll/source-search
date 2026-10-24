import {z} from 'zod';
import type {HttpRead} from '../../platform/http';
import {fail} from '../../domain/identity';
import {checked,pages,identity,identityParts} from '../sync/paging';
import {checkedTask,taskRecord,type TaskProvider} from './model';

export const googleTasksScope='https://www.googleapis.com/auth/tasks.readonly';
const item=z.object({id:z.string().min(1),title:z.string(),notes:z.string().optional(),status:z.enum(['needsAction','completed']),updated:z.string(),completed:z.string().optional(),due:z.string().optional(),parent:z.string().optional(),deleted:z.boolean().optional(),hidden:z.boolean().optional(),links:z.array(z.object({link:z.string(),description:z.string().optional()})).optional()});
const list=z.object({id:z.string().min(1),title:z.string()});
const state=z.object({version:z.literal(1),at:z.iso.datetime(),reconciledAt:z.iso.datetime(),lists:z.array(z.object({list,items:z.array(item)}))});
export function googleTasksProvider(source:string,selected:string[]|undefined,http:HttpRead):TaskProvider{
  async function inventory(path:string){return (await pages(path,async next=>{
    const page=checked(z.object({items:z.array(z.record(z.string(),z.unknown())).optional(),nextPageToken:z.string().optional()}),await http(next));
    return {items:page.items||[],next:page.nextPageToken?path+(path.includes('?')?'&':'?')+'pageToken='+encodeURIComponent(page.nextPageToken):undefined};
  })).items;}
  async function lists(){return checked(z.array(list),await inventory('/users/@me/lists?maxResults=100')).map(l=>({id:l.id,name:l.title}));}
  function record(l:{id:string;name:string},value:unknown){
    const t=checked(item,value);return taskRecord(source,'google-tasks',checkedTask({id:identity([l.id,t.id]),title:t.title||'(Untitled task)',description:[t.notes,...(t.links||[]).map(v=>[v.description,v.link].filter(Boolean).join(': '))].filter(Boolean).join('\n\n'),status:t.status==='completed'?'completed':'open',project:l,parentId:t.parent,completedAt:t.completed,due:t.due?.slice(0,10)}),'https://tasks.google.com/');
  }
  return {lists,async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined;
    // Capture the watermark before the first request; overlap handles updates
    // concurrent with pagination. A daily inventory repairs deletion retention.
    const at=new Date().toISOString(),full=!old||Date.now()-Date.parse(old.reconciledAt)>86400000,available=await lists();
    if(selected?.some(id=>!available.some(l=>l.id===id)))fail('SOURCE_UNAVAILABLE','A selected Google task list is missing or inaccessible');
    const saved:z.infer<typeof state>={version:1,at,reconciledAt:full?at:old!.reconciledAt,lists:[]},records=[];
    for(const l of available.filter(l=>!selected||selected.includes(l.id))){
      const prior=old?.lists.find(v=>v.list.id===l.id),incremental=!full&&prior;
      const path='/lists/'+encodeURIComponent(l.id)+'/tasks?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true&showAssigned=true'+(incremental?'&updatedMin='+encodeURIComponent(new Date(Date.parse(old!.at)-60000).toISOString()):'');
      const map=new Map((incremental?prior.items:[]).map(t=>[t.id,t]));
      for(const raw of await inventory(path)){
        const id=checked(z.string().min(1),raw.id);if(raw.deleted===true)map.delete(id);else map.set(id,checked(item,raw));
      }
      const items=[...map.values()];saved.lists.push({list:{id:l.id,title:l.name},items});records.push(...items.map(t=>record(l,t)));
    }
    return {records,checkpoint:saved,strategy:full?'full-inventory':'modified-since',coverage:'Selected Google task lists, including completed, hidden and assigned tasks; due dates are calendar dates',warnings:[]};
  },async read(id){
    const [listId,taskId]=identityParts(id,2),l=(await lists()).find(l=>l.id===listId&&(!selected||selected.includes(l.id)));
    if(!l)fail('RECORD_NOT_FOUND','Task list is no longer selected or accessible');
    const raw=checked(z.record(z.string(),z.unknown()),await http('/lists/'+encodeURIComponent(listId!)+'/tasks/'+encodeURIComponent(taskId!)));
    if(raw.id!==taskId||raw.deleted===true)fail('RECORD_NOT_FOUND','Task is no longer present');return record(l,raw);
  }};
}
