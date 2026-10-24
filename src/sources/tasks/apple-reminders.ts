import {z} from 'zod';
import {fail} from '../../domain/identity';
import {checkedTask,taskRecord,type TaskProvider} from './model';

export type RemindersRead=(args:string[])=>Promise<unknown[]>;
const list=z.object({id:z.string().min(1).max(500),name:z.string()});
const reminder=z.object({type:z.literal('reminder'),id:z.string().min(1),title:z.string(),notes:z.string().optional(),completed:z.boolean(),priority:z.number().int().min(0).max(9),list,
  createdAt:z.string().optional(),completedAt:z.string().optional(),due:z.string().optional(),start:z.string().optional(),url:z.string().optional(),location:z.string().optional(),recurrence:z.array(z.string()),
});
function complete(data:unknown[],source:string,type:string){
  const rows=data.filter((r:any)=>r?.type===type),footer=data.at(-1) as any;
  if(!footer||footer.type!=='scan_finished'||footer.source!==source||footer.complete!==true||footer.scanned!==rows.length||data.length!==rows.length+1)
    fail('INCOMPLETE_SOURCE','Reminders helper did not complete the scan; previous tasks are retained');
  return rows;
}
export function appleRemindersProvider(source:string,selected:string[]|undefined,read:RemindersRead):TaskProvider{
  const args=selected?['--lists',JSON.stringify([...new Set(selected)])]:[];
  async function lists(){
    const parsed=z.array(list.extend({type:z.literal('reminder_list')})).max(100).safeParse(complete(await read(['reminder-lists','--max-records','101','--max-output-bytes','1048576']),'reminder-lists','reminder_list'));
    if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Invalid Reminders list inventory');
    return parsed.data.map(({id,name})=>({id,name}));
  }
  async function sync(){
    const data=await read(['reminders',...args,'--max-records','20001','--max-output-bytes','32000000']);
    const parsed=z.array(reminder).max(20000).safeParse(complete(data,'reminders','reminder'));
    if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Invalid Reminders snapshot');
    const ids=new Set<string>();
    const records=parsed.data.map(r=>{
      if(ids.has(r.id)||selected&&!selected.includes(r.list.id))fail('INVALID_PROVIDER_RESPONSE','Duplicate reminder or reminder outside the selected lists');
      ids.add(r.id);
      return taskRecord(source,'apple-reminders',checkedTask({id:r.id,title:r.title||'(Untitled reminder)',description:[r.notes,r.start&&'Starts: '+r.start,r.url&&'URL: '+r.url,r.location&&'Location: '+r.location].filter(Boolean).join('\n\n'),
        status:r.completed?'completed':'open',project:r.list,priority:r.priority===0?'none':r.priority<=4?'high':r.priority===5?'medium':'low',
        createdAt:r.createdAt,completedAt:r.completedAt,due:r.due,recurrence:r.recurrence.length?r.recurrence.join('; '):undefined,
      }),'source-search://apple-reminders/'+encodeURIComponent(r.id));
    });
    return {records,strategy:'eventkit-snapshot-row-diff',coverage:'Open and completed reminders visible through EventKit in the selected lists, including notes, dates, priority and recurrence. Tags, subtasks, smart-list membership and attachments are not exposed by this connector.',warnings:[]};
  }
  return {lists,sync,async read(id){const record=(await sync()).records.find(r=>r.ref.id===id);if(!record)fail('RECORD_NOT_FOUND','Reminder is absent from the selected lists; refresh after an account resync');return record;}};
}
