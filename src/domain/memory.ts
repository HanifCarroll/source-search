import {z} from 'zod';
import {refSchema,sourceId} from './contracts';

export const memoryRefSchema=z.object({id:z.uuid(),revision:z.number().int().positive()}).strict();
export const memoryKind=z.enum(['decision','preference','commitment','correction','outcome']);
export const evidenceSchema=z.object({ref:refSchema.extend({version:z.string().min(1).max(100)}),quote:z.string().min(1).max(2000).optional()}).strict();
// Verification is an explicit attestation. Reading a citation never proves a claim.
export const verificationSchema=z.object({method:z.string().min(1).max(1000),observation:z.string().min(1).max(2000),by:z.string().min(1).max(200)}).strict();
export const memoryContentSchema=z.object({
  kind:memoryKind,text:z.string().trim().min(1).max(4000),entities:z.array(sourceId).max(12).default([]),
  evidence:z.array(evidenceSchema).max(5).default([]),corrects:memoryRefSchema.optional(),verification:verificationSchema.optional(),
}).strict().superRefine((m,ctx)=>{
  if(m.kind==='correction'&&!m.corrects)ctx.addIssue({code:'custom',message:'A correction must identify the memory revision it corrects'});
  if(m.verification&&(m.kind!=='outcome'||!m.evidence.length))ctx.addIssue({code:'custom',message:'Only outcomes with evidence can have a verification attestation'});
});
export const writeMemorySchema=z.object({
  operationId:z.uuid(),action:z.enum(['put','retract']).default('put'),id:z.uuid().optional(),expectedRevision:z.number().int().positive().optional(),
  memory:memoryContentSchema.optional(),reason:z.string().trim().min(1).max(1000),
}).strict().superRefine((r,ctx)=>{
  if(!!r.id!==(r.expectedRevision!==undefined))ctx.addIssue({code:'custom',message:'Updates require both id and expectedRevision'});
  if(r.action==='put'&&!r.memory || r.action==='retract'&&(!r.id||r.memory))ctx.addIssue({code:'custom',message:'Put requires memory; retract requires an existing id and no memory'});
  if(Buffer.byteLength(JSON.stringify(r))>16000)ctx.addIssue({code:'custom',message:'Memory request exceeds 16,000 bytes'});
});
export const readMemorySchema=z.object({id:z.uuid(),revision:z.number().int().positive().optional(),checkEvidence:z.boolean().default(false)}).strict();
export const listMemoriesSchema=z.object({query:z.string().max(500).default(''),kind:memoryKind.optional(),entity:sourceId.optional(),includeRetracted:z.boolean().default(false),cursor:z.string().max(2000).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const checkedEvidenceSchema=evidenceSchema.extend({checkedAt:z.iso.datetime(),scope:z.string().min(1).max(100)});
export const memoryRevisionSchema=z.object({
  id:z.uuid(),revision:z.number().int().positive(),sequence:z.number().int().positive(),operationId:z.uuid(),requestHash:z.string().regex(/^[a-f0-9]{64}$/),
  status:z.enum(['active','retracted']),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),reason:z.string().min(1).max(1000),
  content:memoryContentSchema,evidence:z.array(checkedEvidenceSchema).max(5),
}).strict();
export type MemoryRevision=z.infer<typeof memoryRevisionSchema>;
export type MemoryContent=z.infer<typeof memoryContentSchema>;
export type WriteMemory=z.infer<typeof writeMemorySchema>;
export type CheckedEvidence=z.infer<typeof checkedEvidenceSchema>;
