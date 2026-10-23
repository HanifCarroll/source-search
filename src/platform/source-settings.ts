import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {adapterKinds, groupIds, sourceKind} from '../domain/source-catalog';
import {sourceId} from '../domain/contracts';

const path = z.string().refine(isAbsolute, 'Source paths must be absolute');
export const timeZoneSchema = z.string().refine(value => {
  try { new Intl.DateTimeFormat('en', {timeZone:value}); return true; }
  catch { return false; }
}, 'Expected an IANA timezone');
export const accountSchema = z.object({
  account:z.string().min(1).max(200).refine(s => !s.startsWith('-') && !s.includes('\0')),
  email:z.email(),
  aliases:z.array(z.email()).default([]),
});
const common = {label:z.string().min(1).max(120).optional()};
const markdown = z.object({
  ...common,
  adapter:z.literal('markdown'),
  root:path,
  pattern:z.string().min(1).max(500).default('**/*.md'),
  exclude:z.array(z.string().min(1).max(500)).max(50).default(['**/node_modules/**','**/.git/**']),
  dateFields:z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)).max(10).default(['date']),
  dateFromFilename:z.boolean().default(false),
  timeZone:timeZoneSchema.optional(),
  content:z.enum(['note','journal','transcript']).default('note'),
  journal:z.boolean().default(false),
  reviewed:z.boolean().default(false),
  author:z.string().max(200).optional(),
}).strict();
const repeatable = ['gmail','fastmail','markdown','muesli','whatsapp'] as const;
const single = [
  'messages','things-archive','chatgpt-archive','takeout-archive','linkedin-archive','twitter-archive',
  'calendar','contacts','chrome-history','chrome-bookmarks','chrome-downloads','agent-history','vault','library','documents',
] as const;
export const sourceSettings = z.discriminatedUnion('adapter', [
  z.object({...common, adapter:z.literal('gmail'), ...accountSchema.shape}).strict(),
  z.object({...common, adapter:z.literal('fastmail'), ...accountSchema.shape}).strict(),
  markdown,
  z.object({...common, adapter:z.literal('muesli'), database:path}).strict(),
  z.object({...common, adapter:z.literal('whatsapp'), database:path}).strict(),
  ...single.map(adapter => z.object({...common, adapter:z.literal(adapter)}).strict()),
]);
export type SourceSettings = z.infer<typeof sourceSettings>;
export type MarkdownSettings = z.infer<typeof markdown>;
export const sourcesSchema = z.record(sourceId, sourceSettings).default({}).superRefine((sources, ctx) => {
  if(Object.keys(sources).length > 100)ctx.addIssue({code:'custom', message:'At most 100 source instances are supported'});
  for(const [id, setting] of Object.entries(sources)) {
    if(groupIds.includes(id as typeof groupIds[number]))
      ctx.addIssue({code:'custom', path:[id], message:'Source ID conflicts with a source group'});
    if(!repeatable.includes(setting.adapter as typeof repeatable[number]) && id !== setting.adapter)
      ctx.addIssue({code:'custom', path:[id], message:'This integration uses its standard source ID; label can customize its display name'});
    if(adapterKinds.includes(id as typeof adapterKinds[number]) && id !== setting.adapter)
      ctx.addIssue({code:'custom', path:[id], message:'Source ID is reserved for another integration'});
  }
});
export function sourceGroups(config:{sources:Record<string,SourceSettings>; enabledSources:string[]}) {
  const names = [...new Set([...Object.keys(config.sources), ...config.enabledSources])];
  const notes = names.filter(id => sourceKind(id, config) === 'markdown');
  return {
    'all-mail':names.filter(id => ['gmail','fastmail'].includes(sourceKind(id, config))),
    'all-notes':notes,
    'all-journals':notes.filter(id => {
      const setting = config.sources[id];
      return setting?.adapter === 'markdown' ? setting.content === 'journal' || setting.journal : ['journals','voice-journals'].includes(id);
    }),
    'historical-exports':names.filter(id => sourceKind(id, config).endsWith('-archive')),
  };
}
