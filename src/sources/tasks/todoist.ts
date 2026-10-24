import {z} from 'zod';
import {checkedTask,taskRecord,type TaskProvider,type TaskSnapshot} from './model';
import type {TaskHttp} from './http';
import {fail} from '../../domain/identity';

const resource=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),is_deleted:z.boolean().optional()}).passthrough();
const response=z.object({sync_token:z.string().min(1),full_sync:z.boolean(),items:z.array(resource.extend({checked:z.boolean().optional()})).optional(),projects:z.array(resource).optional(),sections:z.array(resource).optional(),notes:z.array(resource).optional()});
type State={token:string;items:Record<string,any>;projects:Record<string,any>;sections:Record<string,any>;notes:Record<string,any>};
const keys=['items','projects','sections','notes'] as const;
function map(source:string,item:any,state:State,comments:string[]){
  if(typeof item.content!=='string'||typeof item.checked!=='boolean')fail('INVALID_PROVIDER_RESPONSE','Todoist task lacks content or completion state');
  const project=Object.hasOwn(state.projects,item.project_id)?state.projects[item.project_id]:undefined;
  const section=Object.hasOwn(state.sections,item.section_id)?state.sections[item.section_id]:undefined;
  if(!project)fail('INVALID_PROVIDER_RESPONSE','Todoist task project is missing from the snapshot');
  return taskRecord(source,'todoist',checkedTask({id:item.id,title:item.content,description:item.description||'',status:item.checked?'completed':'open',
    ...(project?{project:{id:project.id,name:project.name}}:{}),...(section?{section:section.name}:{}),parentId:item.parent_id||undefined,
    labels:item.labels||[],priority:({1:'none',2:'low',3:'medium',4:'high'} as Record<number,string>)[item.priority],
    createdAt:item.added_at||undefined,completedAt:item.completed_at||undefined,due:item.due?.date,deadline:item.deadline?.date,
    recurrence:item.due?.is_recurring?item.due.string:undefined,
    comments,
  }),'https://app.todoist.com/app/task/'+encodeURIComponent(item.id));
}
export function todoistProvider(source:string,http:TaskHttp):TaskProvider{
  async function sync(previous?:unknown):Promise<TaskSnapshot>{
    let state=previous as State|undefined;
    // Full snapshots can lag the server. Follow the first snapshot with one
    // delta before publishing it; never advance a token without its records.
    const initial=!state?.token;
    for(let pass=0;pass<(initial?2:1);pass++){
      const parsed=response.safeParse(await http('/sync',{sync_token:state?.token||'*',resource_types:keys}));
      if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Invalid Todoist sync response');
      const data=parsed.data;
      if(!state&&!data.full_sync)fail('INVALID_PROVIDER_RESPONSE','Todoist initial sync did not return a full snapshot');
      if(data.full_sync||!state){if(keys.some(key=>!Array.isArray(data[key])))fail('INVALID_PROVIDER_RESPONSE','Todoist full snapshot is incomplete');state={token:'',items:{},projects:{},sections:{},notes:{}};}
      else state=structuredClone(state);
      const deletedProjects=new Set((data.projects||[]).filter(p=>p.is_deleted).map(p=>p.id));
      for(const key of keys)for(const entry of data[key]||[]){
        if(entry.id.startsWith('tmp-')||['__proto__','constructor','prototype'].includes(entry.id))fail('INVALID_PROVIDER_RESPONSE','Invalid Todoist resource ID');
        if(entry.is_deleted || key==='items'&&entry.checked)delete state[key][entry.id];else state[key][entry.id]=entry;
      }
      for(const [id,item] of Object.entries(state.items))if(deletedProjects.has(item.project_id))delete state.items[id];
      for(const [id,note] of Object.entries(state.notes))if(!Object.hasOwn(state.items,note.item_id))delete state.notes[id];
      state.token=data.sync_token;
      if(Object.values(state.items).length>20000)fail('SOURCE_LIMIT','Todoist source exceeds 20,000 active tasks');
    }
    const comments=new Map<string,string[]>();
    for(const note of Object.values(state!.notes).sort((a,b)=>a.id.localeCompare(b.id))){const list=comments.get(note.item_id)||[];list.push(note.content);comments.set(note.item_id,list);}
    return {records:Object.values(state!.items).map(i=>map(source,i,state!,comments.get(i.id)||[])),checkpoint:state,
      strategy:'provider-delta',coverage:'Active Todoist tasks, descriptions, project/section names, labels and task comments. Completed/deleted tasks leave the active index; completed-task history is not imported.',warnings:[]};
  }
  return {sync,async read(id,previous){
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id)||id.startsWith('tmp-'))fail('INVALID_REFERENCE','Invalid Todoist task ID');
    const current=await sync(previous),record=current.records.find(r=>r.ref.id===id);
    if(!record)fail('RECORD_NOT_FOUND','Task is no longer in this active Todoist source');return record;
  }};
}
