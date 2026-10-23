import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {defaultConfig} from "../src/config";
import {createRuntime} from "../src/runtime";
const directory=await mkdtemp(join(tmpdir(),"source-search-demo-"));
try {
  await writeFile(join(directory,"2024-01-01.md"),"# Invented journal\n\nThe violet comet is a synthetic example.\n",{mode:0o600});
  const runtime=createRuntime({...defaultConfig(),enabledSources:["journals"],journals:directory});
  const result=await runtime.search_sources({queries:[{source:"journals",query:"violet"}]});
  const ref=result.results[0]?.items[0]?.ref;
  if(!ref)throw Error("Synthetic demo failed to retrieve its invented record");
  const read=await runtime.read_record({ref});
  if(!read.record.body.includes("violet comet"))throw Error("Synthetic original read failed");
  console.log(JSON.stringify({ok:true,source:"invented temporary journal",body:read.record.body,cleanup:"Temporary fixture is removed on exit"},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
