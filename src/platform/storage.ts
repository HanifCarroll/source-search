import { lstat, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { fail } from "../domain/identity";
import {sourceConfig,type Config} from "./config";

export const managedCacheRoot = () => join(homedir(), ".cache/source-search");
const marker = ".source-search-cache";
const owner = "source-search disposable cache v1\n";
export async function privateDirectory(path:string) {
  // Check existing ancestors before mkdir can follow a link.
  for(let current=resolve(path);;current=dirname(current)){
    try{const s=await lstat(current);const systemAlias = process.platform==="darwin" && ["/var","/tmp"].includes(current) && await realpath(current)==="/private"+current;if(!systemAlias && (s.isSymbolicLink() || !s.isDirectory()))fail("UNSAFE_PATH","Cache ancestors must be ordinary directories");}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(dirname(current)===current)break;
  }
  await mkdir(path,{recursive:true,mode:0o700});
  const s=await lstat(path);
  if(s.isSymbolicLink() || !s.isDirectory() || (s.mode & 0o077)!==0)fail("UNSAFE_PATH","Cache directory must be an ordinary private directory (0700)");
}
export async function markManagedCache(path:string) {
  const root=managedCacheRoot(),rel=relative(root,path);
  if(rel===".." || rel.startsWith(".."+sep) || isAbsolute(rel))return;
  await privateDirectory(root);
  try{await writeFile(join(root,marker),owner,{mode:0o600,flag:"wx"});}
  catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;const s=await lstat(join(root,marker));if(!s.isFile() || s.isSymbolicLink() || await readFile(join(root,marker),"utf8")!==owner)fail("UNSAFE_PATH","Invalid cache ownership marker");}
}
function overlaps(a:string,b:string){const rel=relative(resolve(a),resolve(b));return !rel || rel!==".." && !rel.startsWith(".."+sep) && !isAbsolute(rel);}
export async function purgeCache(c:Config,apply=false) {
  const root=managedCacheRoot();
  const selected=Object.values(c.sources).flatMap(s=>[
    ...('root' in s&&s.root?[s.root]:[]),...('database' in s&&s.database&&s.adapter!=='vault'?[s.database]:[]),
    ...('paths' in s?s.paths||[]:[]),...('profiles' in s?s.profiles?.map(p=>p.path)||[]:[]),
    ...('roots' in s?Object.values(s.roots||{}):[]),...('data' in s&&s.data?[s.data]:[]),
  ]);
  const originals=[c.journals,c.things,c.thingsDatabase,c.messages,c.whatsapp,c.muesli,c.voiceNotes,c.callNotes,c.cassData,...c.chromeProfiles,...c.chatgpt,...c.takeout,...c.linkedin,...c.twitter,...c.documentRoots,...Object.values(c.qmdRoots),...c.qmdModels,...Object.values(c.searchModels||{}),...selected];
  if(originals.some(p=>p && overlaps(root,p)))fail("UNSAFE_PATH","A configured original or model is inside the cache directory; move it before purging");
  const custom=[c.index,c.libraryRoot,c.libraryDatabase,c.qmdDatabase,c.previews,...Object.entries(c.sources).filter(([,s])=>s.adapter==='vault').map(([id])=>sourceConfig(c,id).qmdDatabase)].filter(p=>!overlaps(root,p));
  if(custom.length)fail("CUSTOM_CACHE_PATHS","Custom cache paths require manual cleanup; purge refuses to claim complete deletion");
  const result={root,scope:"All Source Search managed caches, extracted attachments and previews",applied:false};
  if(!apply)return result;
  try{await lstat(root);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {...result,applied:true,alreadyAbsent:true};throw e;}
  await privateDirectory(root);
  const mark=await lstat(join(root,marker));
  if(mark.isSymbolicLink() || !mark.isFile() || await readFile(join(root,marker),"utf8")!==owner)fail("UNSAFE_PATH","Cache ownership marker is missing or invalid");
  async function inspect(dir:string):Promise<void>{for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())fail("UNSAFE_PATH","Remove cache links manually before purging");if(entry.isDirectory())await inspect(join(dir,entry.name));}}
  await inspect(root);
  await rm(root,{recursive:true});
  return {...result,applied:true};
}
