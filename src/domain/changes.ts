import {z} from 'zod';
import {sourceId} from './contracts';
import {fail} from './identity';

export const changesSchema=z.object({feed:z.enum(['memory','sources']),sources:z.array(sourceId).min(1).max(20).optional(),cursor:z.string().max(2000).optional(),limit:z.number().int().min(1).max(100).default(25)}).strict().superRefine((r,ctx)=>{
  if(r.feed==='sources'&&!r.sources||r.feed==='memory'&&r.sources)ctx.addIssue({code:'custom',message:'Only the sources feed requires explicit source IDs'});
});
const checkpointSchema=z.object({version:z.literal(1),key:z.string(),epoch:z.string().nullable(),after:z.number().int().nonnegative()}).strict();
export function changePosition(token:string|undefined,key:string,epoch:string|null,high:number){
  if(!token)return 0;
  let c:z.infer<typeof checkpointSchema>;
  try{c=checkpointSchema.parse(JSON.parse(Buffer.from(token,'base64url').toString()));}catch{fail('INVALID_CURSOR','Invalid change-feed cursor');}
  if(c.key!==key)fail('INVALID_CURSOR','Change selection changed; start this feed again');
  if(c.epoch!==null&&c.epoch!==epoch||c.after>high)fail('FEED_RESET','Change history was replaced or cleared; rescan current records and start a new feed');
  return c.after;
}
export const changeCursor=(key:string,epoch:string|null,after:number)=>Buffer.from(JSON.stringify({version:1,key,epoch,after})).toString('base64url');
