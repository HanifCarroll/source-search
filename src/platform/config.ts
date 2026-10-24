import {connectionIdentity} from './auth-settings';
import {createHash} from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {sourceKind,isMail,adapterKinds,connectedKinds} from "../domain/source-catalog";
import {sourcesSchema,accountSchema,timeZoneSchema,type MarkdownSettings} from "./source-settings";
import { sourceId } from "../domain/contracts";
import { fail } from "../domain/identity";
import { readFile } from "node:fs/promises";

const home = homedir();
const path = z.string().refine(isAbsolute, "Source paths must be absolute");
const state = join(home, ".cache/source-search");
const executable=(name:string)=>Bun.which(name) || join(home,".config/source-search/unconfigured/bin",name);
export const configSchema = z.object({
  sources: sourcesSchema,
  timeZone: timeZoneSchema.default("UTC"),
  enabledSources: z.array(sourceId).default([]),
  maintenanceEnabled: z.boolean().default(false),
  mailAccounts: z.record(sourceId,accountSchema).default({}),
  journals: path.default(join(home, ".config/source-search/unconfigured/journals")),
  things: path.default(join(home, ".config/source-search/unconfigured/things")),
  messages: path.default(join(home, "Library/Messages/chat.db")),
  index: path.default(join(state, "archive-index.sqlite")),
  whatsapp: path.default(join(home, "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite")),
  muesli: path.default(join(home, "Library/Application Support/Muesli/muesli.db")),
  voiceNotes: path.optional(),
  callNotes: path.default(join(home, ".config/source-search/unconfigured/calls")),
  chromeProfiles: z.array(path).max(20).default([]),
  chromeProfileIds: z.array(sourceId).max(20).optional(),
  chromeLegacyProfileIds: z.array(sourceId).max(20).optional(),
  thingsDatabase: path.optional(),
  pimHelper: path.default(join(home, ".local/share/source-search/native/Context macOS PIM Helper.app/Contents/MacOS/context-macos-pim-helper")),
  pimLauncher: path.default(join(home, ".local/share/source-search/native/context-macos-pim-disclaim")),
  chatgpt: z.array(path).max(20).default([]),
  takeout: z.array(path).max(20).default([]),
  linkedin: z.array(path).max(20).default([]),
  twitter: z.array(path).max(20).default([]),
  mailbridgeBinary: path.default(executable("mailbridge")),
  bunBinary: path.default(process.execPath),
  nodeBinary: path.default(executable("node")),
  qmdPackage: path.default(join(home, ".bun/install/global/node_modules/@tobilu/qmd")),
  tesseractBinary: path.default(executable("tesseract")),
  ffprobeBinary: path.default(executable("ffprobe")),
  transcriptionBackend: z.string().min(1).max(100).optional(),
  transcriptionModel: z.string().min(1).max(200).optional(),
  ocrLanguages: z.string().regex(/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/).default("eng"),
  transcribeBinary: path.default(executable("transcribe-audio")),
  previews: path.default(join(state, "previews")),
  gmailBinary: path.default(executable("gog")),
  qmdBinary: path.default(executable("qmd")),
  qmdIndex: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("source-search"),
  qmdDatabase: path.default(join(state, "vault.sqlite")),
  qmdModels: z.array(path).default([]),
  searchModels: z.object({embed:path,rerank:path,generate:path}).strict().optional(),
  qmdRoots: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), path).default({}),
  libraryEnabled: z.boolean().default(false),
  libraryRoot: path.default(join(state, "library")),
  libraryIndex: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("source-search-library"),
  libraryDatabase: path.default(join(state, "library-qmd.sqlite")),
  documentRoots: z.array(path).default([]),
  extractorPython: path.default(join(home, ".local/share/source-search/extract-env/bin/python")),
  cassBinary: path.default(executable("cass")),
  cassData: path.default(join(home, ".local/share/cass"))
}).strict().superRefine((c,ctx)=>{
  for(const id of c.enabledSources)if(!c.sources[id] && !adapterKinds.includes(sourceKind(id) as typeof adapterKinds[number]))ctx.addIssue({code:'custom',path:['enabledSources'],message:'Unknown source: '+id});
}).transform(config=>({...config,voiceNotes:config.voiceNotes || config.journals}));
export type Config = z.infer<typeof configSchema>;
export const defaultConfig = () => configSchema.parse({});
export async function loadConfig(): Promise<Config> {
  const path = configPath();
  try { return configSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" && !process.env.SOURCE_SEARCH_CONFIG_FILE) return configSchema.parse({}); throw e; }
}

export const configPath = () => process.env.SOURCE_SEARCH_CONFIG_FILE || join(home, ".config/source-search/config.json");
export function configuredSourceIds(c:Config){return [...new Set([...Object.keys(c.sources),...Object.keys(c.mailAccounts),...c.enabledSources])];}
export function mailAccount(c:Config,id:string){
 const s=c.sources[id];
 if(s && ('account' in s && isMail(id,c)))return {account:s.account,email:s.email,aliases:s.aliases};
 return c.mailAccounts[id];
}
export function databasePath(c:Config,id:string){const s=c.sources[id];return s && 'database' in s && s.database ? s.database : sourceKind(id,c)==='muesli'?c.muesli:c.whatsapp;}
export function markdownSettings(c:Config,id:string):MarkdownSettings{
 const s=c.sources[id];if(s?.adapter==='markdown')return {...s,timeZone:s.timeZone || c.timeZone};
 // Old flat configuration remains readable; personal timezone lives in config.
 return {adapter:'markdown',root:id==='journals'?c.journals:id==='voice-journals'?c.voiceNotes:c.callNotes,pattern:id==='journals'?'**/????-??-??.md':id==='voice-journals'?'**/????-??-?? - Voice - *.md':'**/*.md',exclude:['**/AGENTS.md','**/README.md','**/index.md'],dateFields:id==='journals'?[]:['source_started_at','date'],dateFromFilename:id==='journals',timeZone:c.timeZone,content:id==='journals'?'journal':'transcript',journal:['journals','voice-journals'].includes(id),reviewed:id!=='journals',...(id==='journals'?{author:'self'}:{})};
}
export const sourceEnabled = (config:Config, source:string) => config.enabledSources.includes(source as typeof config.enabledSources[number]);
export function requireSource(config:Config, source:string) { if(!sourceEnabled(config,source)) fail("SOURCE_DISABLED", "Enable this source in local configuration"); }
export function requireMaintenance(config:Config) { if(!config.maintenanceEnabled) fail("MAINTENANCE_DISABLED", "Enable maintenance in local configuration to build caches"); }

// Bind derived text to the selected locations/accounts, not just a stable source ID.
export function sourceScope(config:Config,source:string):string {
  const fields:Record<string,string[]>={
    "things-archive":["things"],"chatgpt-archive":["chatgpt"],"takeout-archive":["takeout"],"linkedin-archive":["linkedin"],"twitter-archive":["twitter"],
    messages:["messages"],whatsapp:["whatsapp"],calls:["muesli"],documents:["documentRoots","takeout","mailAccounts","enabledSources"]
  };
  const kind=sourceKind(source,config),definition=config.sources[source];
  if(definition && connectedKinds.includes(kind as typeof connectedKinds[number]))return createHash('sha256').update(JSON.stringify(connectionIdentity(definition))).digest('hex');
  if(definition && /^(firefox|safari)-/.test(kind) && 'profiles' in definition)return createHash('sha256').update(JSON.stringify({adapter:kind,profiles:definition.profiles})).digest('hex');
  if(definition?.adapter==='tasks'){
    const connector=definition.connector;
    if(connector.type==='microsoft-todo'||connector.type==='google-tasks')return createHash('sha256').update(JSON.stringify({adapter:kind,connection:{type:connector.type,account:connector.account,lists:connector.lists,oauth:connector.oauth}})).digest('hex');
    if(connector.type==='apple-reminders')return createHash('sha256').update(JSON.stringify({adapter:kind,connection:{...connector,helper:connector.helper||config.pimHelper,launcher:connector.launcher||config.pimLauncher}})).digest('hex');
    const connection='token' in connector?(({token,...identity})=>identity)(connector):connector;
    return createHash('sha256').update(JSON.stringify({adapter:kind,connection})).digest('hex');
  }
  if(isMail(source,config)){
    const account=mailAccount(config,source);
    if(definition?.adapter==='jmap' || definition?.adapter==='imap'){
      const endpoint=definition.adapter==='jmap'
        ? {sessionUrl:definition.sessionUrl,accountId:definition.accountId,recordFormat:definition.recordFormat,username:definition.auth.type==='basic'?definition.auth.username:undefined}
        : {host:definition.host,port:definition.port,username:definition.username,folderRoles:definition.folderRoles};
      return createHash('sha256').update(JSON.stringify({adapter:kind,...account,...endpoint,folders:definition.folders})).digest('hex');
    }
    return createHash('sha256').update(JSON.stringify(kind===sourceKind(source)?account:{adapter:kind,...account})||'unconfigured').digest('hex');
  }
  if(definition && ['muesli','whatsapp'].includes(kind) && 'database' in definition){
    const value=source==='calls' && kind==='muesli'?{muesli:definition.database}:source==='whatsapp' && kind==='whatsapp'?{whatsapp:definition.database}:{adapter:kind,database:definition.database};
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  const effective=sourceConfig(config,source);
  const value=Object.fromEntries((fields[kind]||fields[source]||[]).map(key=>[key,(effective as any)[key]]));
  if(kind==='things-archive' && effective.thingsDatabase)value.database=effective.thingsDatabase;
  if(source!==kind && definition && !['markdown'].includes(kind))Object.assign(value,{adapter:kind,definition});
  return createHash("sha256").update(JSON.stringify(value)||"unconfigured").digest("hex");
}

// Per-instance settings resolve at the boundary; old flat settings remain defaults.
export function sourceConfig(c:Config,id:string):Config {
 const s=c.sources[id];if(!s)return c;
 const v={...c};
 if(s.adapter==='messages' && s.database)v.messages=s.database;
 if(s.adapter==='things-archive'){if(s.root)v.things=s.root;if(s.database)v.thingsDatabase=s.database;}
 if('paths' in s && s.adapter.endsWith('-archive'))(v as any)[s.adapter.replace('-archive','')]=s.paths || (v as any)[s.adapter.replace('-archive','')];
 if('profiles' in s && s.profiles){v.chromeProfiles=s.profiles.map(p=>p.path);v.chromeProfileIds=s.profiles.map(p=>p.id);v.chromeLegacyProfileIds='legacyProfileIds' in s?s.legacyProfileIds:undefined;}
 if(s.adapter==='calendar'||s.adapter==='contacts'){v.pimHelper=s.helper||v.pimHelper;v.pimLauncher=s.launcher||v.pimLauncher;}
 if(s.adapter==='agent-history'){v.cassData=s.data||v.cassData;v.cassBinary=s.binary||v.cassBinary;}
 if(s.adapter==='vault'){v.qmdRoots=s.roots||v.qmdRoots;v.qmdDatabase=s.database||(id==='vault'?v.qmdDatabase:join(state,'indexes',id+'.sqlite'));}
 if(id!==s.adapter && s.adapter.endsWith('-archive'))v.index=join(c.index+'.sources',id+'.sqlite');
 return v;
}
