import {z} from 'zod';
import type {Database} from 'bun:sqlite';
import {fail} from '../domain/identity';

const error=z.object({code:z.string(),message:z.string()}).nullable().optional();
const count=z.number().int().nonnegative().optional();
const text=z.string().optional();
const freshness={state:text,error,checkedAt:text,lastSuccessfulSync:text,lastCompleteScan:text,syncStrategy:text,coverage:text};
export const projectionStateSchema=z.object({
  ...freshness,records:count,textRecords:count,chunks:count,publishedAt:text,projectionRevision:text,
  projectionVersion:count,projectionFormat:count,searchVersion:count,scope:text,signature:text,fileStamp:text,consumedRevision:text,
  guard:z.record(z.string(),z.unknown()).optional(),
  incremental:z.object({decoded:z.number().int(),reused:z.number().int(),removed:z.number().int()}).optional(),
  pending:z.union([z.number(),z.array(z.unknown())]).optional(),discovered:count,
  failures:z.array(z.unknown()).optional(),skipped:z.array(z.unknown()).optional(),
});
export const mailStateSchema=z.object({
  ...freshness,state:z.enum(['ready','refreshing','backfilling','error']).optional(),records:count,
  accountSignature:text,projectionVersion:count,dirty:z.boolean().optional(),nextScanAt:z.number().nonnegative().optional(),
  cycle:z.string().nullable().optional(),cursor:text,pageEnd:z.boolean().optional(),
  pending:z.array(z.object({id:z.string(),summary:z.string()})).optional(),
  gmailHistory:text,gmailAnchor:text,gmailPage:text,
  // Provider-specific schemas validate this opaque checkpoint when resuming.
  syncCheckpoint:z.unknown().optional(),
});
export type ProjectionState=z.infer<typeof projectionStateSchema>;
export type MailState=z.infer<typeof mailStateSchema>;
function parse<T>(schema:z.ZodType<T>,data:unknown):T {
  const parsed=schema.safeParse(data);
  if(!parsed.success)fail('INVALID_CACHE','Saved synchronization or projection state is malformed');
  return parsed.data;
}
function rawState(db:Database,table:'states'|'mail_states',source:string):unknown {
  const row=db.query(`SELECT data FROM ${table} WHERE source=?`).get(source) as {data:string}|null;
  if(!row)return;
  try{return JSON.parse(row.data);}catch{return fail('INVALID_CACHE','Saved state is not JSON');}
}
export function getProjectionState(db:Database,source:string):ProjectionState {
  return parse(projectionStateSchema,rawState(db,'states',source) ?? {});
}
export function setProjectionState(db:Database,source:string,data:unknown) {
  db.query('INSERT OR REPLACE INTO states VALUES(?,?)').run(source,JSON.stringify(parse(projectionStateSchema,data)));
}
export function getMailState(db:Database,source:string):MailState {
  // Reading an older installation is mutation-free. The next successful source
  // write migrates its checkpoint; projection writes cannot overwrite it.
  const exists=db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_states'").get();
  const saved=exists?rawState(db,'mail_states',source):undefined;
  if(saved!==undefined)return parse(mailStateSchema,saved);
  const legacy=rawState(db,'states',source);
  // A queued projection has no mailbox checkpoint to migrate.
  if(z.object({state:z.literal('queued')}).safeParse(legacy).success)return {};
  return parse(mailStateSchema,legacy ?? {});
}
export function setMailState(db:Database,source:string,data:unknown) {
  db.query('INSERT OR REPLACE INTO mail_states VALUES(?,?)').run(source,JSON.stringify(parse(mailStateSchema,data)));
}
