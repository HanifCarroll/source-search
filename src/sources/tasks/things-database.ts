import {createSnapshot,requireColumns} from '../../platform/sqlite';
import {hash,versioned,fail,now} from '../../domain/identity';
import type {RecordData} from '../../domain/contracts';
import {taskDueDate} from '../../domain/task-fields';
// Read a selected Things 3 database export, including projects, headings and areas.
export async function thingsDatabase(path:string) {
 const snap=await createSnapshot(path),db=snap.database;
 try {
  requireColumns(db,'TMTask',['uuid','title','notes','type','status','creationDate']);
  const tables=new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(t=>t.name));
  const rows=db.query('SELECT * FROM TMTask ORDER BY uuid LIMIT 200001').all() as any[];
  if(rows.length>200000)fail('SOURCE_LIMIT','Things export exceeds 200,000 records');
  const tasks=new Map(rows.map(r=>[r.uuid,r])),areas=new Map<string,any>(tables.has('TMArea')?(db.query('SELECT * FROM TMArea').all() as any[]).map(r=>[r.uuid,r]):[]);
  const tags=new Map<string,string[]>(rows.map(r=>[r.uuid,[]]));
  if(tables.has('TMTaskTag')&&tables.has('TMTag')){
   requireColumns(db,'TMTaskTag',['tasks','tags']);requireColumns(db,'TMTag',['uuid','title']);
   for(const r of db.query('SELECT t.tasks task,g.title FROM TMTaskTag t JOIN TMTag g ON t.tags=g.uuid ORDER BY g.title').all() as any[])tags.get(r.task)?.push(r.title);
  }
  const checklist=new Map<string,string[]>();
  if(tables.has('TMChecklistItem')){
   requireColumns(db,'TMChecklistItem',['task','title','status']);
   for(const r of db.query('SELECT * FROM TMChecklistItem ORDER BY task,"index"').all() as any[]){const values=checklist.get(r.task)||[];values.push(`[${Number(r.status)===3?'x':' '}] ${r.title}`);checklist.set(r.task,values);}
  }
  const date=(n:unknown)=>{const d=new Date(Number(n)*1000);return n!==null&&n!==undefined&&Number.isFinite(d.getTime())?d.toISOString():undefined;};
  const day=(n:unknown)=>{if(n===null||n===undefined||Number(n)===0)return undefined;const value=Number(n),year=value>>>16,month=(value>>>12)&15,d=(value>>>7)&31;return year>=1900&&month>=1&&month<=12&&d>=1&&d<=31?`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`:undefined;};
  const records=new Map<string,RecordData>();
  for(const r of [...rows,...[...areas.values()].map(a=>({...a,type:3}))]){
   const type=['task','project','heading','area'][Number(r.type)];if(!type)fail('UNSUPPORTED_SCHEMA','Unknown Things record type');
   const status=(['open','', 'canceled','completed'] as const)[Number(r.status??0)];if(!status)fail('UNSUPPORTED_SCHEMA','Unknown Things task status');
   const project=tasks.get(r.project)||tasks.get(tasks.get(r.heading)?.project),area=areas.get(r.area)||areas.get(project?.area);
   const title=r.title||'(Untitled '+type+')';
   const body=[title,`Historical ${type}; status: ${status}; in Trash: ${!!Number(r.trashed)}`,project&&`Project: ${project.title}`,area&&`Area: ${area.title}`,tags.get(r.uuid)?.length&&`Tags: ${tags.get(r.uuid)!.join(', ')}`,day(r.startDate)&&`Start: ${day(r.startDate)}`,day(r.deadline)&&`Deadline: ${day(r.deadline)}`,r.notes,...(checklist.get(r.uuid)||[])].filter(Boolean).join('\n\n');
   const record=versioned({ref:{source:'things-archive',id:String(r.uuid)},title,body,type:'historical-'+type,occurredAt:date(r.creationDate),observedAt:now(),locator:path+'#'+r.uuid,metadata:{historical:true,dateKind:'created',status,trashed:!!Number(r.trashed),project:project?.title,area:area?.title,modifiedAt:date(r.userModificationDate)}});
   // Derived query fields do not change the established original-reference hash.
   if(type==='task')record.task={status,trashed:!!Number(r.trashed),...taskDueDate(day(r.deadline)??(r.deadline?String(r.deadline):undefined)),...(project?{project:{id:String(project.uuid),name:project.title}}:{})};
   if(records.has(record.ref.id))fail('INVALID_ARCHIVE','Duplicate Things UUID');records.set(record.ref.id,record);
  }
  return {records,generation:hash(JSON.stringify([...records.values()].map(r=>r.ref))),info:{taskCount:rows.filter(r=>Number(r.type)===0).length,exportedAt:snap.sourceDatabaseModifiedAt||now(),createdDateRange:undefined,archiveEditedAt:undefined}};
 } finally {await snap.close();}
}
