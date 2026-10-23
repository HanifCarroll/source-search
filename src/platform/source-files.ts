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
  const data = await readFile(path);
  if (data.length > maxBytes) fail("SOURCE_LIMIT", "Source grew beyond the read budget");
  return data.toString("utf8");
}
