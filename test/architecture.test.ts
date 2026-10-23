import {test,expect} from 'bun:test';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import ts from 'typescript';
const root=resolve(import.meta.dir,'../src');
async function modules(dir=root):Promise<string[]> {
 const entries=await readdir(dir,{withFileTypes:true});
 return (await Promise.all(entries.map(e=>e.isDirectory()?modules(resolve(dir,e.name)):e.name.endsWith('.ts')?[resolve(dir,e.name)]:[]))).flat();
}
test('module dependencies keep transport and maintenance out of retrieval and domain code',async()=>{
 const graph=new Map<string,string[]>();
 for(const path of await modules()){
  const name=relative(root,path);
  const code=ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}}).outputText;
  if(name.startsWith('domain/')) {
   const external=[...code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^.'"][^"']*)["']/g)].map(m=>m[1]!);
   for(const dep of external)expect(dep,`${name} must remain free of source I/O`).not.toMatch(/^(?:node:)?(?:fs|child_process|net|http|https)(?:\/|$)|^bun:sqlite$/);
   expect(code,`${name} must remain free of source I/O`).not.toMatch(/\b(?:Bun\.(?:spawn|file|write)|fetch)\s*\(/);
  }
  const dependencies=[...code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)].map(m=>relative(root,resolve(dirname(path),m[1]!.replace(/\.ts$/,'')))+'.ts');
  graph.set(name,dependencies);
  const forbidden=name.startsWith('domain/') || name.startsWith('platform/') ? /^(application|interfaces|maintenance|search|sources)\// : name.startsWith('sources/') ? /^(application|interfaces|maintenance|search)\// : name.startsWith('search/') ? /^(application|interfaces|maintenance)\// : null;
  for(const dep of dependencies)if(forbidden)expect(dep,`${name} must not import ${dep}`).not.toMatch(forbidden);
 }
 function visit(name:string,trail:string[]=[]){
  expect(trail,`Runtime import cycle: ${[...trail,name].join(' -> ')}`).not.toContain(name);
  for(const dep of graph.get(name)||[])visit(dep,[...trail,name]);
 }
 // Every source is a root here; this also checks modules outside the MCP graph.
 for(const name of graph.keys())visit(name);
 function reachable(name:string,seen=new Set<string>()):Set<string>{if(seen.has(name))return seen;seen.add(name);for(const dep of graph.get(name)||[])reachable(dep,seen);return seen;}
 for(const name of reachable('application/api.ts'))expect(name).not.toMatch(/^(maintenance|interfaces)\//);
});
