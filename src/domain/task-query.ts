import type {Page,Query,RecordData,SnapshotCoverage} from './contracts';
import {taskFields} from './task-fields';
import {findRecordMatch} from './content';
import {sortRecords,filterRecord} from './query';
import {hit,within} from './results';
import {cursor,fail,hash,now,numberPosition,queryKey,stableJson} from './identity';

export function taskPage(records:RecordData[],q:Query,coverage:SnapshotCoverage,warnings:string[]=[]):Page{
  let unclassified=0,invalidDue=0;
  const tasks=records.flatMap(r=>{
    const task=taskFields(r);
    if(!task){if(['task','historical-task'].includes(r.type))unclassified++;return [];}
    if(task.trashed)return [];
    if(task.invalidDueDate)invalidDue++;
    return [{...r,task}];
  });
  // Versions and query fields bind continuation to one snapshot. Refresh time
  // and provider ordering do not invalidate an otherwise unchanged result set.
  const identities=records.map(r=>[r.ref,taskFields(r)] as const).sort(([a],[b])=>a.id.localeCompare(b.id));
  const key=queryKey(q)+hash(stableJson(identities))+':task-query-1',start=numberPosition(q.cursor,key);
  const f=q.task||{},sort=q.sort||'due';
  const matching=sortRecords(tasks.filter(r=>{
    const t=r.task;
    return (!f.status||t.status===f.status)&&(!f.projectId||t.project?.id===f.projectId)&&(!f.projectName||t.project?.name===f.projectName)
      &&(!f.dueFrom||!!t.dueDate&&t.dueDate>=f.dueFrom)&&(!f.dueBefore||!!t.dueDate&&t.dueDate<f.dueBefore)
      &&within(r.occurredAt,q)&&filterRecord(r,q)&&!!findRecordMatch(r,q);
  }),{...q,sort});
  if(start>matching.length)fail('INVALID_CURSOR','Cursor is beyond this task snapshot');
  const items=matching.slice(start,start+q.limit).map((r,i)=>({...hit(r,q,start+i+1),cursorAfter:cursor(key,start+i+1)}));
  warnings=[...warnings,...(unclassified?[`${unclassified} task records lack structured fields; sync this source. The total count is unavailable until they can be classified.`]:[]),
    ...(invalidDue?[`${invalidDue} tasks have unsupported due dates; date ranges exclude them. Other task filters still include them.`]:[])];
  return {source:q.source,status:warnings.length?'partial':'ok',items,...(start+items.length<matching.length?{nextCursor:cursor(key,start+items.length)}:{}),
    ...(!unclassified?{totalMatches:matching.length}:{}),coverage:{...coverage,...(unclassified?{unclassifiedTasks:unclassified}:{}),...(invalidDue?{invalidDueDates:invalidDue}:{})},
    warnings,observedAt:now(),query:{sort},scan:{checked:records.length,undecodable:0,exhausted:true}};
}
