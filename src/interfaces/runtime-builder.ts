// Bun caches failed package resolution inside a process. Build each changed
// revision in a fresh process so an installation completed after a failed load
// can recover without restarting the MCP transport.
const worker=`
const {entry,root,path}=await Bun.stdin.json();
try{
  const build=await Bun.build({entrypoints:[entry],target:'bun',define:{SOURCE_SEARCH_PACKAGE_ROOT:JSON.stringify(root)}});
  if(!build.success)throw new AggregateError(build.logs,'Bundle failed');
  await Bun.write(path,build.outputs[0]);
}catch(error){
  console.error((error instanceof AggregateError?error.errors.map(String).join('; '):String(error)).slice(0,5000));
  process.exit(1);
}`;
export async function buildRuntime(entry:string,root:string,path:string){
  const child=Bun.spawn([process.execPath,'--eval',worker],{
    stdin:new Blob([JSON.stringify({entry,root,path})]),stdout:'ignore',stderr:'pipe',
  });
  const timer=setTimeout(()=>child.kill(),30000);
  try{
    const [code,diagnostic]=await Promise.all([child.exited,new Response(child.stderr).text()]);
    if(code)throw Error('Source Search update could not load; correct the code and retry. '+diagnostic.trim().slice(0,500));
  }finally{clearTimeout(timer);}
}
