import {z} from 'zod';
import {fail,versioned,now} from '../../domain/identity';
import type {HttpRead} from '../../platform/http';
import {checked,pages,identity,identityParts} from '../sync/paging';
import type {SourceProvider} from '../sync/model';

const issueFields='id identifier title description url createdAt updatedAt archivedAt dueDate priorityLabel state { name } assignee { name } team { id name } project { id name }';
const commentFields='id body url createdAt updatedAt archivedAt user { name } parent { id } issue { id identifier team { id } project { id } }';
export const linearQueries={
  issues:`query Issues($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt, includeArchived: true) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`,
  comments:`query Comments($filter: CommentFilter, $after: String) { comments(first: 100, after: $after, filter: $filter, orderBy: updatedAt, includeArchived: true) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } }`,
  issue:`query Issue($id: String!) { issue(id: $id) { ${issueFields} } }`,
  comment:`query Comment($id: String!) { comment(id: $id) { ${commentFields} } }`,
  teams:'query Teams($after: String) { teams(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }',
};
const identitySchema=z.object({id:z.string(),identifier:z.string(),team:z.object({id:z.string()}),project:z.object({id:z.string()}).nullable()});
const issue=identitySchema.extend({title:z.string(),description:z.string().nullish(),url:z.string(),createdAt:z.string(),updatedAt:z.string(),archivedAt:z.string().nullable(),dueDate:z.string().nullable(),priorityLabel:z.string(),state:z.object({name:z.string()}),assignee:z.object({name:z.string()}).nullable(),team:z.object({id:z.string(),name:z.string()}),project:z.object({id:z.string(),name:z.string()}).nullable()});
const comment=z.object({id:z.string(),body:z.string(),url:z.string(),createdAt:z.string(),updatedAt:z.string(),archivedAt:z.string().nullable(),user:z.object({name:z.string()}).nullable(),parent:z.object({id:z.string()}).nullable(),issue:identitySchema.nullable()});
const state=z.object({version:z.literal(1),at:z.string(),reconciledAt:z.string(),issues:z.array(issue),comments:z.array(comment)});
export function linearProvider(source:string,selection:{teams:string[];projects?:string[]},http:HttpRead):SourceProvider{
  const scope={team:{id:{in:selection.teams}},...(selection.projects?{project:{id:{in:selection.projects}}}:{})};
  const selected=(p:z.infer<typeof identitySchema>)=>selection.teams.includes(p.team.id)&&(!selection.projects||!!p.project&&selection.projects.includes(p.project.id));
  async function query(document:string,variables:Record<string,unknown>){const result=checked(z.object({data:z.record(z.string(),z.unknown()).nullish(),errors:z.array(z.object({extensions:z.record(z.string(),z.unknown()).optional()})).optional()}),await http('/graphql',{query:document,variables}));if(result.errors?.length||!result.data){const codes=result.errors?.map(v=>v.extensions?.code);fail(codes?.includes('RATELIMITED')?'RATE_LIMITED':codes?.includes('ENTITY_NOT_FOUND')?'RECORD_NOT_FOUND':'PROVIDER_ERROR','Linear query failed; previous snapshot retained');}return result.data;}
  async function list(kind:'issues'|'comments'|'teams',filter?:unknown){return (await pages('first',async cursor=>{const data=await query(linearQueries[kind],{...(filter?{filter}:{}),...(cursor==='first'?{}:{after:cursor})}),value=checked(z.object({nodes:z.array(z.unknown()),pageInfo:z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()})}),data[kind]);if(value.pageInfo.hasNextPage&&!value.pageInfo.endCursor)fail('INCOMPLETE_SOURCE','Linear omitted its continuation cursor');return {items:value.nodes,next:value.pageInfo.hasNextPage?value.pageInfo.endCursor!:undefined};})).items;}
  function issueRecord(p:z.infer<typeof issue>){return versioned({adapter:'issues',ref:{source,id:identity(['issue',p.id])},title:`${p.identifier}: ${p.title}`,body:[p.title,`Team: ${p.team.name}`,p.project&&`Project: ${p.project.name}`,`Status: ${p.state.name}`,`Priority: ${p.priorityLabel}`,p.assignee&&`Assigned: ${p.assignee.name}`,p.dueDate&&`Due: ${p.dueDate}`,p.archivedAt&&'Archived',p.description].filter(Boolean).join('\n\n'),type:'issue',locator:p.url,occurredAt:p.createdAt,observedAt:now(),conversation:p.identifier,metadata:{provider:'linear',modifiedAt:p.updatedAt}});}
  function commentRecord(p:z.infer<typeof comment>){return versioned({adapter:'issues',ref:{source,id:identity(['comment',p.id])},title:`${p.issue!.identifier}: Comment by ${p.user?.name||'deleted user'}`,body:p.body,type:'issue-comment',locator:p.url,occurredAt:p.createdAt,observedAt:now(),conversation:p.issue!.identifier,author:p.user?.name,metadata:{provider:'linear',modifiedAt:p.updatedAt,...(p.parent?{parentComment:p.parent.id}:{})}});}
  return {async lists(){return checked(z.array(z.object({id:z.string(),name:z.string()})),await list('teams'));},async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined,at=now(),full=!old||Date.now()-Date.parse(old.reconciledAt)>86400000,since=full?undefined:{gte:new Date(Date.parse(old!.at)-60000).toISOString()};
    const issues=new Map((full?[]:old!.issues).map(v=>[v.id,v])),comments=new Map((full?[]:old!.comments).map(v=>[v.id,v]));
    for(const v of checked(z.array(issue),await list('issues',{...scope,...(since?{updatedAt:since}:{})}))){if(!selected(v))fail('INVALID_PROVIDER_RESPONSE','Linear returned an issue outside the selected teams/projects');issues.set(v.id,v);}
    for(const v of checked(z.array(comment),await list('comments',{issue:scope,...(since?{updatedAt:since}:{})}))){if(!v.issue||!selected(v.issue))fail('INVALID_PROVIDER_RESPONSE','Linear returned a comment outside the selected teams/projects');comments.set(v.id,v);}
    const saved={version:1 as const,at,reconciledAt:full?at:old!.reconciledAt,issues:[...issues.values()],comments:[...comments.values()].filter(v=>v.issue&&issues.has(v.issue.id))};
    return {records:[...saved.issues.map(issueRecord),...saved.comments.map(commentRecord)],checkpoint:saved,strategy:full?'full-reconciliation':'independent-issue-and-comment-updates',coverage:'Selected Linear teams/projects: issues including archived issues and their comments. Independent updates use overlap; deletions and moves reconcile daily.',warnings:[]};
  },async read(id){const [kind,key]=identityParts(id,2);if(kind==='issue'){const p=checked(issue,(await query(linearQueries.issue,{id:key})).issue);if(p.id!==key||!selected(p))fail('RECORD_NOT_FOUND','Linear issue is no longer selected');return issueRecord(p);}
    if(kind!=='comment')fail('INVALID_REFERENCE','Unknown Linear record kind');const p=checked(comment,(await query(linearQueries.comment,{id:key})).comment);if(p.id!==key||!p.issue||!selected(p.issue))fail('RECORD_NOT_FOUND','Linear comment is no longer selected');return commentRecord(p);
  }};
}
