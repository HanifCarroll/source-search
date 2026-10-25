import {z} from 'zod';
import {isAbsolute} from 'node:path';

// CASS limits count UTF-16 code units. Retain that contract, including NUL
// rejection and empty-string normalization, when validating with Zod.
const text = (max = 4096, empty = false) => z.string().refine(
  value => (empty || value.length > 0) && value.length <= max && !value.includes('\0'));
const nullable = <T extends z.ZodType>(schema:T) => schema.nullish().transform(value => value ?? null);
const optionalText = (max = 4096) => z.preprocess(value => value === '' ? null : value, nullable(text(max)));
const integer = nullable(z.number().int());
const boolean = nullable(z.boolean());
const strings = (max = 128) => z.array(text(512)).max(max).nullish().transform(value => value ?? []);
const object = z.record(z.string(), z.unknown());
const optionalObject = object.nullish().transform(value => value ?? {});
const defaultObject = <T extends z.ZodType>(schema:T) => z.preprocess(value => value ?? {}, schema);

export const hitSchema = z.object({
  source_path:text().refine(isAbsolute), line_number:nullable(z.number().int().positive()),
  agent:text(128), source_id:text(256), origin_kind:text(64), origin_host:optionalText(256),
  workspace:optionalText(), workspace_original:optionalText(),
  created_at:nullable(z.union([text(128,true), z.number()])), match_type:optionalText(64),
  title:optionalText(), snippet:optionalText(100000), score:nullable(z.number()),
});
export const searchSchema = (maxQueryChars:number) => z.object({
  // Only the requested prefix is inspected, as before; surplus provider hits
  // are clamped and never become part of the returned result.
  hits:z.array(z.unknown()), query:optionalText(maxQueryChars),
  total_matches:nullable(z.number().int().nonnegative()),
  limit:nullable(z.number().int().nonnegative()), offset:nullable(z.number().int().nonnegative()),
  hits_clamped:boolean, _warning:nullable(text(512)),
  budget:defaultObject(z.object({elapsed_ms:integer,budget_ms:integer,timed_out:boolean})),
  _meta:defaultObject(z.object({next_cursor:optionalText(),search_mode:optionalText(64),
    requested_search_mode:optionalText(64),fallback_tier:optionalText(64),
    fallback_reason:optionalText(512),semantic_refinement:boolean})),
});
export const contextSchema = z.object({
  path:text(),target_line:integer,context:z.number().int().nonnegative(),total_lines:z.number().int().nonnegative(),
  source_exists:z.boolean(),archive_only:z.boolean(),
  lines:z.array(z.object({line:z.number().int().positive(),content:text(100000),highlighted:z.boolean()})),
});
const healthIndex = z.object({
  exists:boolean,status:optionalText(128),fresh:boolean,stale:boolean,reason:optionalText(1000),
  recommended_action:optionalText(1000),engine_incompatible:boolean,documents:integer,
  fingerprint:defaultObject(z.object({current_db_fingerprint:optionalText(256),checkpoint_fingerprint:optionalText(256)})),
  checkpoint:optionalObject,hollow:z.unknown().optional(),partial:z.unknown().optional(),
});
export const healthSchema = z.preprocess(value => {
  if(!object.safeParse(value).success)return value;
  const raw=value as Record<string,unknown>, state=object.safeParse(raw.state);
  return {...raw,index:raw.index ?? (state.success ? state.data.index : undefined),
    database:raw.database ?? raw.db ?? (state.success ? state.data.database : undefined),
    rebuild:raw.rebuild ?? (state.success ? state.data.rebuild : undefined)};
}, z.object({
  state:optionalObject,healthy:z.boolean(),initialized:boolean,status:optionalText(128),health_level:optionalText(128),
  explanation:optionalText(1000),recommended_action:optionalText(1000),data_dir:optionalText(),
  warnings:strings(32),errors:strings(32),index:defaultObject(healthIndex),
  database:defaultObject(z.object({exists:boolean,opened:boolean,conversations:integer,messages:integer})),
  rebuild:defaultObject(z.object({active:boolean,stalled:boolean})),
}));
export const onboardingSchema = z.object({
  providers:z.array(z.object({name:text(128),readiness:optionalText(128),estimated_sessions:integer})).max(128),
  data_dir:optionalText(),excluded_providers:strings(),estimated_index_sessions:integer,indexed_conversation_count:integer,
  semantic_ready:boolean,mutation_free:boolean,recommended_action:optionalText(256),warnings:strings(32),
});
