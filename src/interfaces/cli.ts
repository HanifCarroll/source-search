import {purgeCache} from "../platform/storage";
process.umask(0o077);
import { loadConfig } from "../platform/config";
import { createRuntime } from "../application/runtime";
import { rebuildArchive } from "../sources/archives/index";
import { errorData } from "../domain/identity";

const [command, argument] = process.argv.slice(2);
try {
  const config = await loadConfig(), runtime = createRuntime(config);
  let result: unknown;
  if (command === "sources") result = await runtime.list_sources();
  else if (command === "search") result = await runtime.search_sources(JSON.parse(argument || await Bun.stdin.text()));
  else if (command === "read") result = await runtime.read_record(JSON.parse(argument || await Bun.stdin.text()));
  else if (command === "rebuild") result = await rebuildArchive(config);
  else if (command === "purge-cache") result = await purgeCache(config,argument === "--apply");
  else if (command === "mcp") { await import("./mcp"); }
  else {
    console.log("source-search sources | search '<JSON>' | read '<JSON>' | rebuild | purge-cache [--apply] | mcp\nSearch input: {\"queries\":[{\"source\":\"journals\",\"query\":\"consulting\"}]}\nRead input: {\"ref\":{\"source\":\"journals\",\"id\":\"<returned ID>\"}}\nSearch and read accept JSON on stdin. Rebuild changes only the disposable archive index.");
  }
  if (result !== undefined) console.log(JSON.stringify({ ok: true, data: result }));
} catch (error) { console.error(JSON.stringify({ ok: false, error: errorData(error) })); process.exitCode = 1; }
