import {z} from 'zod';
import {googleAuth,microsoftAuth,oneCredential,secretSchema} from './auth-settings';
export const syncLimits=z.object({timeoutMs:z.number().int().min(1000).max(3600000).default(600000),maxRequests:z.number().int().min(1).max(100000).default(10000)}).strict().default({timeoutMs:600000,maxRequests:10000});
const common={label:z.string().max(120).optional(),sync:syncLimits};
const repositoryName=z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).refine(v=>v.split('/').every(p=>p!=='.'&&p!=='..'),'Use owner/repository');
const githubEndpoint=z.url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!v.endsWith('/');}).default('https://api.github.com');
const account=z.string().min(1).max(200);
const selected=z.array(z.string().min(1).max(2000)).min(1).max(100).optional();
const google=z.object({type:z.literal('google'),account,collections:selected,...googleAuth}).strict().refine(oneCredential,'Select Google OAuth or an external token');
const microsoft=z.object({type:z.literal('microsoft'),account,collections:selected,...microsoftAuth}).strict().refine(oneCredential,'Select Microsoft OAuth or an external token');
export const calendarWindowSchema=z.object({pastDays:z.number().int().min(0).max(36500).default(730),futureDays:z.number().int().min(1).max(36500).default(365)}).strict().default({pastDays:730,futureDays:365});
const davFields={account,serverUrl:z.url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;},'Use an HTTPS DAV endpoint'),username:z.string().min(1),password:secretSchema,collections:selected,allowedOrigins:z.array(z.url().refine(v=>new URL(v).protocol==='https:'&&new URL(v).origin===v)).max(10).default([]),timeZone:z.string().default('UTC').refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Use an IANA timezone')};
const caldav=z.object({type:z.literal('caldav'),...davFields}).strict(),carddav=z.object({type:z.literal('carddav'),...davFields}).strict();
export type DavSettings=z.infer<typeof caldav>|z.infer<typeof carddav>;
export const calendarSettings=z.object({adapter:z.literal('calendars'),...common,window:calendarWindowSchema,connector:z.discriminatedUnion('type',[google,microsoft,caldav])}).strict();
export const contactSettings=z.object({adapter:z.literal('address-books'),...common,connector:z.discriminatedUnion('type',[z.object({type:z.literal('google'),account,...googleAuth}).strict().refine(oneCredential,'Select Google OAuth or an external token'),microsoft,carddav])}).strict();
export type CalendarSettings=z.infer<typeof calendarSettings>;
export type ContactSettings=z.infer<typeof contactSettings>;
const notionSelection=z.array(z.uuid()).max(100).default([]);
export const noteSettings=z.object({adapter:z.literal('notes'),...common,connector:z.object({type:z.literal('notion'),account,token:secretSchema,pages:notionSelection,dataSources:notionSelection}).strict().refine(v=>v.pages.length+v.dataSources.length>0,'Select Notion pages or data sources')}).strict();
export const fileSettings=z.object({adapter:z.literal('files'),...common,roots:z.array(z.string().min(1).max(2000)).min(1).max(100),excludeNames:z.array(z.string().min(1).max(500)).max(100).default(['Books','Ebooks']),content:z.enum(['metadata','text']).default('metadata'),maxTextBytes:z.number().int().min(1024).max(32*1024*1024).default(8*1024*1024),connector:z.discriminatedUnion('type',[z.object({type:z.literal('google'),account,...googleAuth}).strict().refine(oneCredential,'Select Google OAuth or an external token'),z.object({type:z.literal('microsoft'),account,driveId:z.string().min(1).max(500).optional(),...microsoftAuth}).strict().refine(oneCredential,'Select Microsoft OAuth or an external token')])}).strict();
export const issueSettings=z.object({adapter:z.literal('issues'),...common,connector:z.discriminatedUnion('type',[z.object({type:z.literal('github'),account,token:secretSchema,repositories:z.array(repositoryName).min(1).max(100),apiUrl:githubEndpoint}).strict(),z.object({type:z.literal('linear'),account,token:secretSchema,authMode:z.enum(['api-key','oauth']).default('api-key'),teams:z.array(z.uuid()).min(1).max(100),projects:z.array(z.uuid()).min(1).max(100).optional()}).strict()])}).strict();
const repositorySelection=z.union([repositoryName,z.object({name:repositoryName,branch:z.string().min(1).max(250).regex(/^[^\s\x00-\x1f\x7f]+$/).refine(v=>v.split('/').every(p=>p&&p!=='.'&&p!=='..'),'Use an exact branch name').optional()}).strict()]).transform(v=>typeof v==='string'?{name:v.toLowerCase()}:{...v,name:v.name.toLowerCase()});
const pathPatterns=z.array(z.string().min(1).max(1000)).max(100);
export const repositorySettings=z.object({
  adapter:z.literal('repositories'),...common,
  include:pathPatterns.min(1).default(['**/*']),
  exclude:pathPatterns.default(['**/node_modules/**','**/vendor/**','**/dist/**','**/build/**','**/coverage/**','**/.git/**','**/*.min.js','**/*.map','**/package-lock.json','**/yarn.lock','**/pnpm-lock.yaml','**/bun.lock','**/bun.lockb']),
  maxFileBytes:z.number().int().min(1).max(8*1024*1024).default(1024*1024),
  maxTotalBytes:z.number().int().min(1).max(48*1024*1024).default(32*1024*1024),
  connector:z.object({type:z.literal('github'),account,token:secretSchema,apiUrl:githubEndpoint,
    repositories:z.array(repositorySelection).max(100).default([]).refine(v=>new Set(v.map(r=>r.name)).size===v.length,'Select each repository once; use another source for a different branch')}).strict(),
}).strict();
export type RepositorySettings=z.infer<typeof repositorySettings>;
export const chatSettings=z.object({adapter:z.literal('chat'),...common,connector:z.object({type:z.literal('slack'),account,workspace:z.string().regex(/^T[A-Z0-9]+$/),channels:z.array(z.string().regex(/^[CGD][A-Z0-9]+$/)).min(1).max(100),token:secretSchema,historyDays:z.number().int().min(1).max(36500).default(90)}).strict()}).strict();
export const connectedSettings=[calendarSettings,contactSettings,noteSettings,fileSettings,issueSettings,chatSettings,repositorySettings] as const;
