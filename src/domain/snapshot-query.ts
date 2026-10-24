import type {Page,Query,RecordData,SnapshotCoverage} from './contracts';
import {taskFields} from './task-fields';
import {findRecordMatch} from './content';
import {sortRecords,filterRecord} from './query';
import {hit,within} from './results';
import {overlaps} from './date-range';
import {cursor,fail,hash,now,numberPosition,queryKey,stableJson} from './identity';

// Complete, bounded snapshots can count every match before paging. Direct and
// streaming readers keep their candidate-scan pagination in pages.ts.
export function snapshotPage(records:RecordData[],q:Query,coverage:SnapshotCoverage,warnings:string[]=[]):Page{
  const exactTasks=!!q.task||q.sort==='due',f=q.task||{};
  let unclassified=0,invalidDue=0;
  const candidates=exactTasks?records.flatMap(r=>{
    const task=taskFields(r);
    if(!task){if(['task','historical-task'].includes(r.type))unclassified++;return [];}
    if(task.trashed)return [];
    if(task.invalidDueDate)invalidDue++;
    return [{...r,task}];
  }):records;
  // Continuation follows content and selection, not observation time or the
  // order in which a provider happened to return the same records.
  const identities=records.map(r=>[r.ref,exactTasks?taskFields(r):undefined] as const).sort(([a],[b])=>a.id.localeCompare(b.id));
  const key=queryKey(q)+hash(stableJson({identities,window:coverage.window}))+':snapshot-query-1',start=numberPosition(q.cursor,key);
  const sort=q.sort||(exactTasks?'due':'newest');
  const matching=sortRecords(candidates.filter(r=>{
    const t=r.task;
    return (!exactTasks||!!t&&(!f.status||t.status===f.status)&&(!f.projectId||t.project?.id===f.projectId)&&(!f.projectName||t.project?.name===f.projectName)
      &&(!f.dueFrom||!!t.dueDate&&t.dueDate>=f.dueFrom)&&(!f.dueBefore||!!t.dueDate&&t.dueDate<f.dueBefore))
      &&(r.type==='calendar-event'?overlaps(r.occurredAt,r.metadata?.endedAt,q):within(r.occurredAt,q))
      &&(!q.conversation||r.conversation===q.conversation)&&filterRecord(r,q)&&!!findRecordMatch(r,q);
  }),{...q,sort});
  if(start>matching.length)fail('INVALID_CURSOR','Cursor is beyond this source snapshot');
  const items=matching.slice(start,start+q.limit).map((r,i)=>({...hit(r,q,start+i+1),cursorAfter:cursor(key,start+i+1)}));
  const outside=coverage.window&&((q.from&&Date.parse(q.from)<Date.parse(coverage.window.from))||(q.to&&Date.parse(q.to)>Date.parse(coverage.window.to)));
  warnings=[...warnings,
    ...(outside?[`Snapshot covers ${coverage.window!.from} to ${coverage.window!.to}; widen the configured window and sync to search outside it`]:[]),
    ...(coverage.lastError?['Using the last successful snapshot; latest sync failed: '+coverage.lastError.code]:[]),
    ...(unclassified?[`${unclassified} task records lack structured fields; sync this source. The total count is unavailable until they can be classified.`]:[]),
    ...(invalidDue?[`${invalidDue} tasks have unsupported due dates; date ranges exclude them. Other task filters still include them.`]:[])];
  return {source:q.source,status:warnings.length?'partial':'ok',items,...(start+items.length<matching.length?{nextCursor:cursor(key,start+items.length)}:{}),
    ...(!unclassified?{totalMatches:matching.length}:{}),coverage:{...coverage,...(unclassified?{unclassifiedTasks:unclassified}:{}),...(invalidDue?{invalidDueDates:invalidDue}:{})},
    warnings,observedAt:now(),query:{sort,...(records.some(r=>r.type==='calendar-event')?{dateMatch:'overlap'}:{})},scan:{checked:records.length,undecodable:0,exhausted:true}};
}
