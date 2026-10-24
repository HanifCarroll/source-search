import {z} from 'zod';
import {querySchema,refSchema,sourceId,type RecordData,type RecordIdentifier} from './contracts';
import {normalizeIdentifier} from './identifiers';

const identifierSchema=z.object({
  kind:z.enum(['email','phone','person-id','project-id','repository']),value:z.string().min(1).max(500),source:sourceId.optional(),
}).strict().superRefine((v,ctx)=>{
  if(!normalizeIdentifier(v.kind,v.value))ctx.addIssue({code:'custom',path:['value'],message:'Use a complete email address, international phone number, or provider identifier'});
  if(!['email','phone'].includes(v.kind)&&!v.source)ctx.addIssue({code:'custom',path:['source'],message:'Provider identifiers require a source ID'});
});
const savedQuerySchema=z.object({...querySchema.shape,cursor:z.never().optional(),limit:z.never().optional()}).strict()
  .refine(q=>!q.from||!q.to||Date.parse(q.from)<Date.parse(q.to),'from must precede to');
const entitySchema=z.object({
  kind:z.enum(['person','project']),label:z.string().min(1).max(200),
  identifiers:z.array(identifierSchema).max(30).default([]),
  records:z.array(refSchema).max(20).default([]),
  queries:z.array(savedQuerySchema).max(12).default([]),
  people:z.array(sourceId).max(12).default([]),
}).strict();
export const contextEntitiesSchema=z.record(sourceId,entitySchema).default({}).superRefine((entities,ctx)=>{
  if(Object.keys(entities).length>500)ctx.addIssue({code:'custom',message:'Configure at most 500 context entities'});
  for(const [id,entity] of Object.entries(entities)) {
    if(entity.kind==='person'&&entity.people.length)ctx.addIssue({code:'custom',path:[id,'people'],message:'Only projects have related people'});
    for(const person of entity.people)if(entities[person]?.kind!=='person')ctx.addIssue({code:'custom',path:[id,'people'],message:'Related people must name configured person entities'});
    for(const identifier of entity.identifiers)if((entity.kind==='person')===['project-id','repository'].includes(identifier.kind))ctx.addIssue({code:'custom',path:[id,'identifiers'],message:'Choose identifiers appropriate to the entity kind'});
  }
});
export type ContextEntities=z.infer<typeof contextEntitiesSchema>;
export const listEntitiesSchema=z.object({kind:z.enum(['person','project']).optional(),query:z.string().max(200).default(''),cursor:sourceId.optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const contextRequestSchema=z.object({
  mode:z.enum(['meeting-prep','project-resume']),entity:sourceId.optional(),meeting:refSchema.optional(),
  sources:z.array(sourceId).min(1).max(12),limit:z.number().int().min(1).max(20).default(12),
}).strict().superRefine((v,ctx)=>{
  if(v.mode==='meeting-prep'&&!v.meeting)ctx.addIssue({code:'custom',path:['meeting'],message:'Meeting preparation requires a calendar record reference'});
  if(v.mode==='project-resume'&&!v.entity)ctx.addIssue({code:'custom',path:['entity'],message:'Project resumption requires a configured project ID'});
  if(v.mode==='project-resume'&&v.meeting)ctx.addIssue({code:'custom',path:['meeting'],message:'Use meeting-prep for calendar context'});
  if(new Set(v.sources).size!==v.sources.length)ctx.addIssue({code:'custom',path:['sources'],message:'Choose each source once'});
});

export type EntityLink={entity:string;via:'record'|'identifier';identifier?:RecordIdentifier};
export type AmbiguousLink={identifier:RecordIdentifier;entities:string[]};
export function matchEntities(record:RecordData,entities:ContextEntities):{links:EntityLink[];ambiguous:AmbiguousLink[]} {
  const links:EntityLink[]=[],ambiguous:AmbiguousLink[]=[];
  for(const [id,entity] of Object.entries(entities))if(entity.records.some(ref=>ref.source===record.ref.source&&ref.id===record.ref.id&&(!ref.version||ref.version===record.ref.version)))links.push({entity:id,via:'record'});
  const values=[...(record.identifiers||[]),...(record.task?.project?.id?[{kind:'project-id' as const,value:record.task.project.id}]:[])];
  const seen=new Set<string>();
  for(const identifier of values) {
    const value=normalizeIdentifier(identifier.kind,identifier.value),key=JSON.stringify([identifier.kind,value]);
    if(!value||seen.has(key))continue;seen.add(key);
    const matches=Object.entries(entities).filter(([,entity])=>entity.identifiers.some(v=>v.kind===identifier.kind&&(!v.source||v.source===record.ref.source)&&normalizeIdentifier(v.kind,v.value)===value)).map(([id])=>id);
    if(matches.length>1)ambiguous.push({identifier:{kind:identifier.kind,value},entities:matches});
    else if(matches.length===1)links.push({entity:matches[0]!,via:'identifier',identifier:{kind:identifier.kind,value}});
  }
  return {links,ambiguous};
}
