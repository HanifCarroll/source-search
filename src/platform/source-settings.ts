import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {adapterKinds, groupIds, sourceKind, sourceCategory} from '../domain/source-catalog';
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
// Credentials are resolved at request time, including commands that refresh OAuth tokens.
export const secretSchema = z.union([
  z.object({env:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)}).strict(),
  z.object({file:path}).strict(),
  z.object({command:z.array(z.string().min(1).max(2000)).min(1).max(20)}).strict(),
]);
const nativeMail = {
  ...common, ...accountSchema.shape,
  folders:z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  timeoutMs:z.number().int().min(100).max(120000).default(30000),
};
export const jmapSettings = z.object({
  ...nativeMail, adapter:z.literal('jmap'),
  sessionUrl:z.url().refine(s=>{const u=new URL(s);return !u.username && !u.password && !u.hash && (u.protocol==='https:' || u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname));},'Use HTTPS (HTTP is allowed only on loopback)'),
  accountId:z.string().min(1).max(255).optional(),
  recordFormat:z.enum(['complete','mailbridge-v1']).default('complete'),
  auth:z.discriminatedUnion('type',[
    z.object({type:z.literal('bearer'),token:secretSchema}).strict(),
    z.object({type:z.literal('basic'),username:z.string().min(1),password:secretSchema}).strict(),
  ]),
}).strict();
export const imapSettings = z.object({
  ...nativeMail, adapter:z.literal('imap'),
  host:z.string().min(1).max(255).regex(/^[^\s/\x00-\x1f]+$/),
  port:z.number().int().min(1).max(65535).default(993),
  security:z.enum(['tls','starttls']).default('tls'),
  caFile:path.optional(),
  username:z.string().min(1).max(500),
  auth:z.discriminatedUnion('type',[
    z.object({type:z.literal('password'),password:secretSchema}).strict(),
    z.object({type:z.literal('oauth2'),accessToken:secretSchema}).strict(),
  ]),
  // Servers without SPECIAL-USE can name their roles here, including localized folders.
  folderRoles:z.record(z.string().min(1).max(200),z.enum(['inbox','sent','drafts','archive','junk','trash','all'])).default({}),
  maxSearchMessages:z.number().int().min(1).max(100000).default(20000),
  maxMessageBytes:z.number().int().min(1024).max(25000000).default(10000000),
}).strict();
export type JmapSettings = z.infer<typeof jmapSettings>;
export type ImapSettings = z.infer<typeof imapSettings>;
export type Secret = z.infer<typeof secretSchema>;
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
const files = z.array(path).min(1).max(20);
const profile = z.object({id:sourceId,path}).strict();
const single = ['library','documents'] as const;
export const taskSettings = z.object({
  ...common, adapter:z.literal('tasks'),
  connector:z.discriminatedUnion('type',[
    z.object({type:z.literal('things'),database:path.optional(),root:path.optional()}).strict().refine(s=>!!s.database!==!!s.root,'Select a Things database or export folder'),
    z.object({type:z.literal('todoist'),account:z.string().min(1).max(200),token:secretSchema}).strict(),
    z.object({type:z.literal('ticktick'),account:z.string().min(1).max(200),token:secretSchema,projects:z.array(z.string().min(1).max(200)).min(1).max(100)}).strict(),
    z.object({type:z.literal('apple-reminders'),helper:path.optional(),launcher:path.optional(),lists:z.array(z.string().min(1).max(500)).min(1).max(100).optional()}).strict(),
    z.object({type:z.literal('microsoft-todo'),account:z.string().min(1).max(200),lists:z.array(z.string().min(1).max(500)).min(1).max(100).optional(),token:secretSchema.optional(),
      oauth:z.object({clientId:z.uuid(),tenant:z.union([z.enum(['common','consumers','organizations']),z.uuid()]).default('common'),cache:path}).strict().optional(),
    }).strict().refine(s=>!!s.token!==!!s.oauth,'Select a Microsoft OAuth login or an external access token'),
    z.object({type:z.literal('json'),paths:files}).strict(),
  ]),
}).strict();
export type TaskSettings=z.infer<typeof taskSettings>;
export const sourceSettings = z.discriminatedUnion('adapter', [
  z.object({...common, adapter:z.literal('gmail'), ...accountSchema.shape}).strict(),
  z.object({...common, adapter:z.literal('fastmail'), ...accountSchema.shape}).strict(),
  ...(['firefox-history','firefox-bookmarks','safari-history','safari-bookmarks'] as const).map(adapter=>z.object({...common,adapter:z.literal(adapter),profiles:z.array(profile).min(1).max(20).refine(p=>new Set(p.map(v=>v.id)).size===p.length,'Profile IDs must be unique')}).strict()),
  taskSettings,
  jmapSettings,
  imapSettings,
  markdown,
  z.object({...common, adapter:z.literal('muesli'), database:path}).strict(),
  z.object({...common, adapter:z.literal('whatsapp'), database:path}).strict(),
  z.object({...common, adapter:z.literal('messages'), database:path.optional()}).strict(),
  z.object({...common, adapter:z.literal('things-archive'), root:path.optional(), database:path.optional()}).strict(),
  ...(['chatgpt-archive','takeout-archive','linkedin-archive','twitter-archive'] as const).map(adapter=>z.object({...common,adapter:z.literal(adapter),paths:files.optional()}).strict()),
  ...(['browser-history','browser-bookmarks','browser-downloads','chrome-history','chrome-bookmarks','chrome-downloads'] as const).map(adapter=>z.object({...common,adapter:z.literal(adapter),profiles:z.array(profile).min(1).max(20).refine(p=>new Set(p.map(v=>v.id)).size===p.length,'Profile IDs must be unique').optional(),legacyProfileIds:z.array(sourceId).max(20).optional()}).strict()),
  ...(['calendar','contacts'] as const).map(adapter=>z.object({...common,adapter:z.literal(adapter),helper:path.optional(),launcher:path.optional()}).strict()),
  z.object({...common,adapter:z.literal('ical'),paths:files,timeZone:timeZoneSchema.optional()}).strict(),
  z.object({...common,adapter:z.literal('vcard'),paths:files}).strict(),
  z.object({...common,adapter:z.literal('agent-history'),data:path.optional(),binary:path.optional()}).strict(),
  z.object({...common,adapter:z.literal('vault'),roots:z.record(sourceId,path).optional(),database:path.optional()}).strict(),
  ...single.map(adapter => z.object({...common, adapter:z.literal(adapter)}).strict()),
]);
export type SourceSettings = z.infer<typeof sourceSettings>;
export type MarkdownSettings = z.infer<typeof markdown>;
export const sourcesSchema = z.record(sourceId, sourceSettings).default({}).superRefine((sources, ctx) => {
  if(Object.keys(sources).length > 100)ctx.addIssue({code:'custom', message:'At most 100 source instances are supported'});
  for(const [id, setting] of Object.entries(sources)) {
    if(groupIds.includes(id as typeof groupIds[number]))
      ctx.addIssue({code:'custom', path:[id], message:'Source ID conflicts with a source group'});
    if(single.includes(setting.adapter as typeof single[number]) && id !== setting.adapter)
      ctx.addIssue({code:'custom', path:[id], message:'This integration uses its standard source ID; label can customize its display name'});
    if(adapterKinds.includes(id as typeof adapterKinds[number]) && !['tasks','browser-history','browser-bookmarks','browser-downloads'].includes(id) && id !== setting.adapter)
      ctx.addIssue({code:'custom', path:[id], message:'Source ID is reserved for another integration'});
  }
});
export function sourceGroups(config:{sources:Record<string,SourceSettings>; enabledSources:string[]}) {
  const names = [...new Set([...Object.keys(config.sources), ...config.enabledSources])];
  const notes = names.filter(id => sourceKind(id, config) === 'markdown');
  return {
    'all-tasks':names.filter(id=>sourceCategory(id,config)==='tasks'),
    'all-browser-history':names.filter(id=>sourceCategory(id,config)==='browser-history'),
    'all-bookmarks':names.filter(id=>sourceCategory(id,config)==='browser-bookmarks'),
    'all-calendars':names.filter(id=>sourceCategory(id,config)==='calendars'),
    'all-contacts':names.filter(id=>sourceCategory(id,config)==='contacts'),
    'all-mail':names.filter(id => ['gmail','fastmail','jmap','imap'].includes(sourceKind(id, config))),
    'all-notes':notes,
    'all-journals':notes.filter(id => {
      const setting = config.sources[id];
      return setting?.adapter === 'markdown' ? setting.content === 'journal' || setting.journal : ['journals','voice-journals'].includes(id);
    }),
    'historical-exports':names.filter(id => sourceKind(id, config).endsWith('-archive')),
  };
}
