import {z} from 'zod';
import {checkedTask,taskRecord,type TaskProvider} from './model';
import type {TaskHttp} from './http';
import {fail} from '../../domain/identity';
const project=z.object({id:z.string(),name:z.string()}).passthrough();
const task=z.object({id:z.string(),projectId:z.string(),title:z.string(),status:z.number().int()}).passthrough();
const projectData=z.object({project,tasks:z.array(task).max(20000),columns:z.array(z.object({id:z.string(),name:z.string()})).optional()});
function record(source:string,item:any,p:any,columns:{id:string;name:string}[]=[]){
  if(![0,2].includes(item.status))fail('INVALID_PROVIDER_RESPONSE','Unknown TickTick task status');
  const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():undefined;
  return taskRecord(source,'ticktick',checkedTask({id:item.id,title:item.title,description:[item.content,item.desc].filter(Boolean).join('\n\n'),
    status:item.status===2?'completed':'open',project:{id:p.id,name:p.name},parentId:item.parentId||undefined,section:columns.find(c=>c.id===item.columnId)?.name,
    labels:item.tags||[],priority:({0:'none',1:'low',3:'medium',5:'high'} as Record<number,string>)[item.priority],
    createdAt:date(item.createdTime),completedAt:item.status===2?date(item.completedTime):undefined,due:item.dueDate,recurrence:item.repeatFlag||undefined,
    checklist:(item.items||[]).map((i:any)=>({title:i.title,completed:i.status===1||i.status===2})),
  }),'https://ticktick.com/webapp/#p/'+encodeURIComponent(p.id)+'/tasks/'+encodeURIComponent(item.id));
}
export function ticktickProvider(source:string,projects:string[],http:TaskHttp):TaskProvider{
  async function snapshot(){
    const records=[],ids=new Set<string>();
    for(const id of [...new Set(projects)]){
      const parsed=projectData.safeParse(await http('/project/'+encodeURIComponent(id)+'/data'));
      if(!parsed.success||parsed.data.project.id!==id||parsed.data.tasks.some(t=>t.projectId!==id))fail('INVALID_PROVIDER_RESPONSE','Invalid TickTick project snapshot');
      for(const task of parsed.data.tasks){if(ids.has(task.id))fail('INVALID_PROVIDER_RESPONSE','Duplicate task in TickTick project snapshots; retry after the move completes');ids.add(task.id);}
      records.push(...parsed.data.tasks.map(t=>record(source,t,parsed.data.project,parsed.data.columns)));
      if(records.length>20000)fail('SOURCE_LIMIT','TickTick source exceeds 20,000 tasks');
    }
    return {records,strategy:'snapshot-row-diff',coverage:'Tasks returned by the selected TickTick projects, including descriptions, labels and checklists. Only these project snapshots are indexed; full completed-task history and comments are not imported.',warnings:[]};
  }
  return {sync:snapshot,async read(id){const current=await snapshot(),r=current.records.find(r=>r.ref.id===id);if(!r)fail('RECORD_NOT_FOUND','Task is absent from the selected TickTick projects');return r;}};
}
