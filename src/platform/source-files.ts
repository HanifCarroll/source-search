import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail } from "../domain/identity";
export async function regular(path: string) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink()) fail("UNSAFE_PATH", "Source must be a regular file, not a symbolic link");
  return st;
}
export async function contained(root: string, name: string) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("UNSAFE_PATH", "Source root must be an ordinary directory");
  if (isAbsolute(name)) fail("UNSAFE_PATH", "Expected a source-relative record ID");
  const target = resolve(root, name), rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) fail("UNSAFE_PATH", "Record is outside its source root");
  const actualRoot = await realpath(root), actual = await realpath(target);
  const actualRel = relative(actualRoot, actual);
  if (actualRel === ".." || actualRel.startsWith(".." + sep) || isAbsolute(actualRel)) fail("UNSAFE_PATH", "Record link escapes its source root");
  // Reject symlinked directories too, including links that happen to stay inside the root.
  let path = resolve(root);
  for (const part of rel.split(sep)) { path = resolve(path, part); if ((await lstat(path)).isSymbolicLink()) fail("UNSAFE_PATH", "Source links are not followed"); }
  await regular(target); return target;
}
export async function textFile(path: string, maxBytes = 2 * 1024 * 1024) {
  const st = await regular(path); if (st.size > maxBytes) fail("SOURCE_LIMIT", "Source file exceeds the read budget");
  const stamp=JSON.stringify([st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.mode]),saved=textCache.get(path);
  if(saved?.stamp===stamp)return saved.text;
  if(saved){textBytes-=saved.bytes;textCache.delete(path);}
  const data = await readFile(path);
  if (data.length > maxBytes) fail("SOURCE_LIMIT", "Source grew beyond the read budget");
  const text=data.toString('utf8');
  // Small live text sources (notes, ICS, vCards, bookmarks) reuse unchanged
  // bytes. Full exports remain streamed/uncached and reads still check paths.
  if(data.length<=256*1024){
    const after=await regular(path);
    if(stamp===JSON.stringify([after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs,after.mode])){
      while(textBytes+data.length>32*1024*1024 || textCache.size>=2048){const key=textCache.keys().next().value!;textBytes-=textCache.get(key)!.bytes;textCache.delete(key);}
      textCache.set(path,{stamp,text,bytes:data.length});textBytes+=data.length;
    }
  }
  return text;
}
const textCache=new Map<string,{stamp:string;text:string;bytes:number}>();
let textBytes=0;
