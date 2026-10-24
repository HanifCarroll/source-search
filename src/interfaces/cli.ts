import {purgeCache} from "../platform/storage";
process.umask(0o077);
import { loadConfig } from "../platform/config";
import { createRuntime } from "../application/runtime";
import { rebuildConfiguredArchives } from "../maintenance/archives";
import {setup,doctor,mcpConfig,downloadModels} from "./setup";
import {indexSources} from "../maintenance/search-index";
import {syncTasks} from '../maintenance/tasks';
import { errorData } from "../domain/identity";

const [command, argument] = process.argv.slice(2);
try {
  if(command === "setup"){console.log(JSON.stringify({ok:true,data:await setup(process.argv.slice(3))}));process.exit(0);}
  const config = await loadConfig(), runtime = createRuntime(config);
  let result: unknown;
  if(command === "doctor") result=await doctor(config);
  else if(command === "mcp-config") {console.log(JSON.stringify(mcpConfig(config),null,2));process.exit(0);}
  else if(command === "index") result=await indexSources(config,process.argv.slice(3));
  else if(command === "models" && argument === "download") result=await downloadModels(config);
  else if (command === "sources") result = await runtime.list_sources();
  else if (command === "search") result = await runtime.search_sources(JSON.parse(argument || await Bun.stdin.text()));
  else if (command === "read") result = await runtime.read_record(JSON.parse(argument || await Bun.stdin.text()));
  else if (command === "rebuild") result = await rebuildConfiguredArchives(config);
  else if(command === 'sync-tasks') {result=await syncTasks(config,argument);if(!(result as {ok:boolean}).ok)process.exitCode=1;}
  else if (command === "purge-cache") result = await purgeCache(config,argument === "--apply");
  else if (command === "mcp") { await import("./mcp"); }
  else {
    console.log("source-search setup [--notes /folder] | doctor | mcp-config | models download | index [--source ID | --library] [--embed] | sources | search '<JSON>' | read '<JSON>' | rebuild | sync-tasks [SOURCE_ID] | purge-cache [--apply] | mcp\nSearch input: {\"queries\":[{\"source\":\"notes\",\"query\":\"meeting\"}]}\nRead input: {\"ref\":{\"source\":\"notes\",\"id\":\"<returned ID>\"}}\nSearch and read accept JSON on stdin. Rebuild changes only the disposable archive index.");
  }
  if (result !== undefined) console.log(JSON.stringify({ ok: true, data: result }));
} catch (error) { console.error(JSON.stringify({ ok: false, error: errorData(error) })); process.exitCode = 1; }
