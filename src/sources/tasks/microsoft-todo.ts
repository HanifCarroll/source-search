import {z} from 'zod';
import {Temporal} from '@js-temporal/polyfill';
import {fail,hash,stableJson} from '../../domain/identity';
import {readableHtml} from '../../formats/html';
import {checkedTask,taskRecord,type TaskProvider} from './model';
import type {TaskHttp} from './http';

export const graphOrigin='https://graph.microsoft.com/v1.0';
const id=z.string().min(1).max(500);
const listSchema=z.object({id,displayName:z.string()});
const dateSchema=z.object({dateTime:z.string(),timeZone:z.string()});
const taskSchema=z.object({id,title:z.string(),status:z.enum(['notStarted','inProgress','completed','waitingOnOthers','deferred']),
  body:z.object({contentType:z.enum(['text','html']),content:z.string()}).nullish(),categories:z.array(z.string()).optional(),importance:z.enum(['low','normal','high']).optional(),
  createdDateTime:z.iso.datetime({offset:true}).optional(),dueDateTime:dateSchema.nullish(),startDateTime:dateSchema.nullish(),completedDateTime:dateSchema.nullish(),reminderDateTime:dateSchema.nullish(),isReminderOn:z.boolean().optional(),
  recurrence:z.object({pattern:z.record(z.string(),z.unknown()),range:z.record(z.string(),z.unknown())}).nullish(),hasAttachments:z.boolean().optional(),
  checklistItems:z.array(z.object({id,displayName:z.string(),isChecked:z.boolean(),createdDateTime:z.string().optional()})).max(10000),
  linkedResources:z.array(z.object({id,displayName:z.string().optional(),applicationName:z.string().optional(),webUrl:z.string().nullish()})).max(10000),
});
type GraphTask=z.infer<typeof taskSchema>;
type GraphList=z.infer<typeof listSchema>;
const checkpointSchema=z.object({version:z.literal(1),lists:z.array(z.object({list:listSchema,delta:z.string().optional(),reconciledAt:z.iso.datetime().optional(),tasks:z.array(taskSchema).max(20000)})).max(100)});
type Checkpoint=z.infer<typeof checkpointSchema>;
const listPath=(id:string)=>'/me/todo/lists/'+encodeURIComponent(id);
const taskPath=(list:string,id:string)=>listPath(list)+'/tasks/'+encodeURIComponent(id);
const identity=(list:string,id:string)=>hash(JSON.stringify([list,id]));

// Next/delta links are opaque, but must remain in this exact collection. Never
// send the account token to a URL chosen by a response or a modified cache.
export function graphLink(link:string,collection:string):string{
  let url:URL;try{url=new URL(link);}catch{return fail('INVALID_PROVIDER_RESPONSE','Invalid Microsoft continuation link');}
  if(url.origin!=='https://graph.microsoft.com'||url.username||url.password||url.hash||decodeURI(url.pathname)!==decodeURI('/v1.0'+collection))fail('INVALID_PROVIDER_RESPONSE','Microsoft continuation left its collection');
  return url.pathname.slice('/v1.0'.length)+url.search;
}
export function microsoftTodoProvider(source:string,selected:string[]|undefined,http:TaskHttp):TaskProvider{
  let requests=0;
  const get=async(path:string)=>{if(++requests>2000)fail('SOURCE_LIMIT','Microsoft sync exceeded 2,000 requests; select fewer lists');return http(path);};
  async function pages(collection:string,start=collection,delta=false){
    const values:any[]=[],seen=new Set<string>();let next=start;
    while(next){
      if(seen.has(next))fail('INVALID_PROVIDER_RESPONSE','Microsoft repeated a continuation page');seen.add(next);
      const parsed=z.object({value:z.array(z.record(z.string(),z.unknown())), '@odata.nextLink':z.string().optional(),'@odata.deltaLink':z.string().optional()}).safeParse(await get(next));
      if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Invalid Microsoft collection response');
      const page=parsed.data,n=page['@odata.nextLink'],d=page['@odata.deltaLink'];
      if(n&&d||!delta&&d)fail('INVALID_PROVIDER_RESPONSE','Invalid Microsoft pagination state');
      values.push(...page.value);if(values.length>40000)fail('SOURCE_LIMIT','Microsoft collection exceeds the sync budget');
      if(d)return {values,delta:graphOrigin+graphLink(d,collection)};
      if(!n){if(delta)fail('INCOMPLETE_SOURCE','Microsoft delta scan ended without a checkpoint');return {values,delta:undefined};}
      next=graphLink(n,collection);
    }
    return {values,delta:undefined};
  }
  async function lists(){
    const parsed=z.array(listSchema).max(100).safeParse((await pages('/me/todo/lists')).values);
    if(!parsed.success||new Set(parsed.data.map(l=>l.id)).size!==parsed.data.length)fail('INVALID_PROVIDER_RESPONSE','Invalid Microsoft To Do list inventory');
    return parsed.data.map(l=>({id:l.id,name:l.displayName}));
  }
  async function hydrate(list:string,raw:any):Promise<GraphTask>{
    if(!id.safeParse(raw.id).success)fail('INVALID_PROVIDER_RESPONSE','Microsoft task has no identity');
    const path=taskPath(list,raw.id);
    for(const relationship of ['checklistItems','linkedResources'] as const){
      const continuation=raw[relationship+'@odata.nextLink'];
      if(continuation){
        if(!Array.isArray(raw[relationship]))fail('INVALID_PROVIDER_RESPONSE','Invalid Microsoft task relationship');
        raw[relationship]=[...raw[relationship],...(await pages(path+'/'+relationship,graphLink(continuation,path+'/'+relationship))).values];
        delete raw[relationship+'@odata.nextLink'];
      }else if(!Array.isArray(raw[relationship]))raw[relationship]=(await pages(path+'/'+relationship)).values;
    }
    const parsed=taskSchema.safeParse(raw);if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Invalid Microsoft To Do task');
    for(const relationship of ['checklistItems','linkedResources'] as const)if(new Set(parsed.data[relationship].map(i=>i.id)).size!==parsed.data[relationship].length)fail('INVALID_PROVIDER_RESPONSE','Duplicate Microsoft task relationship');
    parsed.data.checklistItems.sort((a,b)=>(a.createdDateTime||'').localeCompare(b.createdDateTime||'')||a.id.localeCompare(b.id));
    parsed.data.linkedResources.sort((a,b)=>a.id.localeCompare(b.id));
    parsed.data.categories?.sort();
    return parsed.data;
  }
  async function currentTask(list:string,id:string){
    const raw=await get(taskPath(list,id));
    if(!raw||typeof raw!=='object'||(raw as any).id!==id)fail('INVALID_PROVIDER_RESPONSE','Microsoft returned a different task');
    return hydrate(list,raw);
  }
  async function sync(previous?:unknown){
    const parsed=checkpointSchema.safeParse(previous),old=parsed.success?parsed.data:undefined;
    const inventory=await lists();
    if(selected?.some(id=>!inventory.some(l=>l.id===id)))fail('SOURCE_UNAVAILABLE','A selected Microsoft To Do list is missing or inaccessible');
    const checkpoint:Checkpoint={version:1,lists:[]};let fallback=false,count=0;
    for(const list of inventory.filter(l=>!selected||selected.includes(l.id))){
      const prior=old?.lists.find(l=>l.list.id===list.id),collection=listPath(list.id)+'/tasks',deltaCollection=collection+'/delta';
      // Relationship-only changes are not universally guaranteed by Graph
      // change feeds. Reconcile daily while using deltas between full passes.
      let full=!prior?.delta||!prior.reconciledAt||Date.now()-Date.parse(prior.reconciledAt)>=86400000,result;
      try{result=await pages(deltaCollection,!full?graphLink(prior!.delta!,deltaCollection):deltaCollection+'?$expand=checklistItems,linkedResources',true);}
      catch(e){
        if((e as any).code==='SYNC_STATE_EXPIRED'&&prior?.delta){full=true;result=await pages(deltaCollection,deltaCollection+'?$expand=checklistItems,linkedResources',true);}
        // Some tenants reject read-only delta access or expansion. Keep the
        // Tasks.Read grant and reconcile a complete ordinary snapshot instead.
        else if([400,403,405,501].includes((e as any).httpStatus)){full=true;fallback=true;result=await pages(collection);}
        else throw e;
      }
      const tasks=new Map((full?[]:prior!.tasks).map(t=>[t.id,t]));
      for(const raw of result.values){
        if(!id.safeParse(raw.id).success)fail('INVALID_PROVIDER_RESPONSE','Microsoft delta has no task identity');
        if(raw['@removed']){tasks.delete(raw.id);continue;}
        // Delta updates may omit unchanged properties. Relationship arrays
        // omitted from a change are refreshed, not reused from an old task.
        const merged={...tasks.get(raw.id),...raw};
        for(const relation of ['checklistItems','linkedResources'])if(!(relation in raw))delete merged[relation];
        if(typeof merged.title!=='string'||typeof merged.status!=='string')tasks.set(raw.id,await currentTask(list.id,raw.id));
        else tasks.set(raw.id,await hydrate(list.id,merged));
        if(tasks.size>20000)fail('SOURCE_LIMIT','Microsoft source exceeds 20,000 tasks');
      }
      count+=tasks.size;if(count>20000)fail('SOURCE_LIMIT','Microsoft source exceeds 20,000 tasks');
      checkpoint.lists.push({list:{id:list.id,displayName:list.name},delta:result.delta,reconciledAt:full?new Date().toISOString():prior!.reconciledAt,tasks:[...tasks.values()]});
    }
    return {records:checkpoint.lists.flatMap(l=>l.tasks.map(t=>record(source,l.list,t))),checkpoint,strategy:fallback?'graph-snapshot-row-diff':'graph-task-delta',
      coverage:'Open and completed tasks in the selected Microsoft To Do lists, including notes, steps, categories, dates, recurrence and linked resources. Attachment contents, Planner tasks and My Day membership are not imported.',
      warnings:fallback?['Microsoft delta was unavailable with this account; refreshed complete task snapshots with read access.']:[]};
  }
  return {lists,sync,async read(ref,previous){
    const parsed=checkpointSchema.safeParse(previous);if(!parsed.success)fail('NEEDS_SYNC','Synchronize this Microsoft task source before reading records');
    const saved=parsed.data.lists.find(l=>l.tasks.some(t=>identity(l.list.id,t.id)===ref));
    if(!saved||selected&&!selected.includes(saved.list.id))fail('RECORD_NOT_FOUND','Task is absent from the selected Microsoft lists');
    const list=(await lists()).find(l=>l.id===saved.list.id);if(!list)fail('RECORD_NOT_FOUND','Microsoft task list is no longer accessible');
    const task=saved.tasks.find(t=>identity(saved.list.id,t.id)===ref)!;
    return record(source,{id:list.id,displayName:list.name},await currentTask(list.id,task.id));
  }};
}
function dateText(value:z.infer<typeof dateSchema>|null|undefined){return value?value.dateTime+' ['+value.timeZone+']':undefined;}
function instant(value:z.infer<typeof dateSchema>|null|undefined){
  if(!value)return undefined;
  try{return Temporal.PlainDateTime.from(value.dateTime).toZonedDateTime(value.timeZone).toInstant().toString();}catch{return undefined;}
}
function record(source:string,list:GraphList,t:GraphTask){
  const body=t.body?.contentType==='html'?readableHtml(t.body.content):t.body?.content;
  const description=[body,'Progress: '+t.status,t.startDateTime&&'Starts: '+dateText(t.startDateTime),t.completedDateTime&&'Completed: '+dateText(t.completedDateTime),
    t.isReminderOn&&t.reminderDateTime&&'Reminder: '+dateText(t.reminderDateTime),t.hasAttachments&&'Has file attachments',
    ...t.linkedResources.map(r=>['Linked resource:',r.displayName,r.applicationName,r.webUrl].filter(Boolean).join(' '))].filter(Boolean).join('\n\n');
  return taskRecord(source,'microsoft-todo',checkedTask({id:identity(list.id,t.id),title:t.title||'(Untitled task)',description,status:t.status==='completed'?'completed':'open',
    project:{id:list.id,name:list.displayName},labels:t.categories||[],priority:t.importance,createdAt:t.createdDateTime,completedAt:instant(t.completedDateTime),due:dateText(t.dueDateTime),
    recurrence:t.recurrence?stableJson(t.recurrence):undefined,checklist:t.checklistItems.map(i=>({title:i.displayName,completed:i.isChecked})),
  }),graphOrigin+taskPath(list.id,t.id));
}
