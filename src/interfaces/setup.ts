import {readFile,writeFile,mkdir,copyFile,rename,access,readdir,rm,mkdtemp} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createInterface} from 'node:readline/promises';
import {configPath,configSchema,sourceConfig,type Config} from '../platform/config';
import {packageRoot} from '../platform/package-root';
import {createRuntime} from '../application/runtime';
import {sourceKind} from '../domain/source-catalog';
import {searchModels,modelsPresent} from '../search/qmd/runner';
import {fail} from '../domain/identity';

export async function readSettings(path=configPath()):Promise<Record<string,any>> {
 try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw e;}
}
export async function saveSettings(value:Record<string,unknown>,path=configPath()) {
 configSchema.parse(value);
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 let backup:string|undefined;
 try{await access(path);backup=path+'.backup-'+Date.now();await copyFile(path,backup,constants.COPYFILE_EXCL);await import('node:fs/promises').then(fs=>fs.chmod(backup!,0o600));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const temporary=path+'.'+crypto.randomUUID()+'.tmp';
 try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
 return {config:path,backup};
}
export function mcpConfig(c:Config,path=configPath()) {
 return {mcpServers:{'source-search':{command:c.bunBinary,args:[join(packageRoot,'src/mcp.ts')],env:{SOURCE_SEARCH_CONFIG_FILE:resolve(path)}}}};
}
export async function doctor(c:Config) {
 const sources=await createRuntime(c).list_sources();
 const checks:{name:string;available:boolean;action?:string}[]=[];
 const check=async(name:string,path:string,action:string,executable=true)=>checks.push({name,available:await access(path,executable?constants.X_OK:constants.R_OK).then(()=>true,()=>false),action});
 const kinds=new Set(c.enabledSources.map(id=>sourceKind(id,c)));
 if(kinds.has('gmail'))await check('Gmail CLI',c.gmailBinary,'Install gog or configure an IMAP/JMAP source.');
 if(kinds.has('fastmail'))await check('Legacy mailbridge',c.mailbridgeBinary,'Use a native JMAP source for a new installation.');
 for(const id of c.enabledSources){const s=sourceConfig(c,id),kind=sourceKind(id,c);
  if(kind==='agent-history')await check(id+' CASS',s.cassBinary,'Install CASS and build its index.');
  if(kind==='calendar'||kind==='contacts')await check(id+' macOS helper',s.pimHelper,'Build the optional macOS helper, or use ical/vcard files.');
 }
 if(kinds.has('documents')){
  await check('Document Python environment',c.extractorPython,'Create the optional extraction environment from scripts/extraction-requirements.txt.');
  await check('OCR (images and scanned PDFs)',c.tesseractBinary,'Install Tesseract for OCR.');
  await check('Media inspection',c.ffprobeBinary,'Install FFmpeg for audio/video extraction.');
  await check('Local transcription',c.transcribeBinary,'Configure a local transcription executable for audio/video files.');
 }
 if(kinds.has('vault')||kinds.has('library')){
  checks.push({name:'Semantic search models',available:!!searchModels(c)&&await modelsPresent(c),action:'Run bun src/cli.ts models download, then index --embed. Keyword search needs no models.'});
  if(process.platform==='darwin'){
   const available=(await Promise.all(['/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib','/usr/local/opt/sqlite/lib/libsqlite3.dylib'].map(p=>access(p,constants.R_OK).then(()=>true,()=>false)))).some(Boolean);
   checks.push({name:'SQLite vector extension support',available,action:'Install Homebrew SQLite (brew install sqlite) for semantic and hybrid search on macOS. Keyword search works without it.'});
  }
 }
 return {platform:process.platform,config:configPath(),checks:checks.map(({action,...check})=>({...check,...(!check.available?{action}:{})})),sources};
}

// Explicit download through the dependency's supported CLI; indexing/search use its SDK.
export async function downloadModels(c:Config) {
 const temporary=await mkdtemp(join(tmpdir(),'source-search-models-'));
 const cache=join(homedir(),'.cache/source-search-models');
 const models={embed:'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',rerank:'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',generate:'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf'};
 try{
  await writeFile(join(temporary,'source-search.yml'),JSON.stringify({collections:{},models}),{mode:0o600});
  const child=Bun.spawn([c.bunBinary,join(packageRoot,'node_modules/@tobilu/qmd/bin/qmd'),'--index','source-search','pull'],{cwd:temporary,stdin:'ignore',stdout:'inherit',stderr:'inherit',env:{...process.env,XDG_CACHE_HOME:cache,QMD_CONFIG_DIR:temporary,INDEX_PATH:join(temporary,'index.sqlite'),QMD_EMBED_MODEL:models.embed,QMD_RERANK_MODEL:models.rerank,QMD_GENERATE_MODEL:models.generate}});
  if(await child.exited)fail('MODEL_DOWNLOAD_FAILED','Model download did not finish; retry models download.');
  const root=join(cache,'qmd/models'),files=await readdir(root),installed=Object.fromEntries(Object.entries(models).map(([kind,uri])=>{const matches=files.filter(f=>f.endsWith(uri.split('/').at(-1)!));if(matches.length!==1)fail('MODEL_DOWNLOAD_FAILED','Could not identify the downloaded '+kind+' model');return [kind,join(root,matches[0])];}));
  return {...await saveSettings({...await readSettings(),searchModels:installed}),models:installed};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
export async function setup(args:string[]) {
 const settings=await readSettings(),rl=createInterface({input:process.stdin,output:process.stderr});
 const ask=async(prompt:string,fallback='')=>(await rl.question(prompt+(fallback?` [${fallback}]`:'')+': ')).trim()||fallback;
 const absolute=(value:string)=>resolve(value.startsWith('~/')?join(homedir(),value.slice(2)):value);
 try{
  const note=args.indexOf('--notes');
  if(note>=0){
   if(!args[note+1])fail('INVALID_CONFIG','--notes requires a folder');
   const root=absolute(args[note+1]),existing=settings.sources?.notes;
   if(existing && (existing.adapter!=='markdown'||existing.root!==root))fail('SOURCE_EXISTS','The notes source already uses different settings; use interactive setup to add a named source.');
   settings.sources={...settings.sources,notes:existing||{adapter:'markdown',root}};settings.enabledSources=[...new Set([...(settings.enabledSources||[]),'notes'])];
  }
  else{
   if(!process.stdin.isTTY)fail('INTERACTIVE_INPUT_REQUIRED','Use setup --notes /path/to/notes for unattended setup, or edit config.example.json.');
   console.error('Add sources by name. Existing settings and source IDs are kept. Leave the integration blank to finish.');
   settings.timeZone=await ask('Timezone',settings.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
   settings.sources={...settings.sources};settings.enabledSources=[...(settings.enabledSources||[])];
   while(true){
    const adapter=await ask('Integration (markdown, imap, jmap, tasks, ical, vcard, browser-history, vault, agent-history, chatgpt-archive; blank to finish)');if(!adapter)break;
    const id=await ask('Source ID (keep it stable for saved references)',adapter==='markdown'?'notes':adapter);
    if(settings.sources[id])fail('SOURCE_EXISTS','That source ID already exists; edit its settings directly or choose another ID.');
    const definition:any={adapter};
    const path=async(prompt:string)=>{const value=await ask(prompt);if(!value)fail('INVALID_CONFIG','A path is required');return absolute(value);};
    if(adapter==='markdown')definition.root=await path('Notes folder');
    else if(adapter==='vault')definition.roots={notes:await path('Markdown folder to index')};
    else if(adapter==='imap'||adapter==='jmap'){
     definition.email=await ask('Email address');definition.account=id;
     if(adapter==='imap'){
      definition.host=await ask('IMAP hostname');definition.username=await ask('Login',definition.email);
      definition.port=Number(await ask('Port','993'));definition.security=await ask('Security (tls or starttls)',definition.port===993?'tls':'starttls');
      definition.auth={type:'password',password:{file:await path('File containing the app password')}};
     }else{definition.sessionUrl=await ask('JMAP session URL');definition.auth={type:'bearer',token:{file:await path('File containing the API token')}};}
    }else if(adapter==='ical'||adapter==='vcard'||['chatgpt-archive','takeout-archive','linkedin-archive','twitter-archive'].includes(adapter))definition.paths=[await path('Export file')];
    else if(['messages','whatsapp','muesli','things-archive'].includes(adapter))definition.database=await path('SQLite database or exported main.sqlite');
    else if(adapter==='tasks'){
     const type=await ask('Task app (things, todoist, ticktick, json)');
     if(type==='things')definition.connector={type,database:await path('Things main.sqlite')};
     else if(type==='json')definition.connector={type,paths:[await path('Task JSON file')]};
     else if(type==='todoist'||type==='ticktick'){
      definition.connector={type,account:await ask('Stable account name',id),token:{file:await path('File containing the API token')}};
      if(type==='ticktick')definition.connector.projects=(await ask('Project IDs, separated by commas')).split(',').map(s=>s.trim()).filter(Boolean);
     }else fail('INVALID_CONFIG','Unknown task connector');
    }
    else if(adapter.startsWith('chrome-')||adapter.startsWith('browser-'))definition.profiles=[{id:await ask('Stable profile ID','default'),path:await path('Chromium profile folder')}];
    else if(adapter==='agent-history'){definition.data=await path('CASS data folder');definition.binary=await path('CASS executable');}
    else if(!['calendar','contacts','library','documents'].includes(adapter))fail('INVALID_CONFIG','Unknown integration');
    configSchema.parse({...settings,sources:{...settings.sources,[id]:definition},enabledSources:[...settings.enabledSources,id]});
    settings.sources[id]=definition;settings.enabledSources.push(id);
   }
   if(Object.values(settings.sources).some((s:any)=>['vault','tasks'].includes(s.adapter))||settings.enabledSources.includes('library')){
    settings.maintenanceEnabled=(await ask('Enable explicit index maintenance? (yes/no)',settings.maintenanceEnabled?'yes':'no'))==='yes';
    settings.libraryEnabled=settings.enabledSources.includes('library');
   }
  }
  const result=await saveSettings(settings);return {...result,next:['bun src/cli.ts doctor','bun src/cli.ts mcp-config']};
 }finally{rl.close();}
}
