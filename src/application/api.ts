import { loadConfig } from "../platform/config";
import { createRuntime } from "./runtime";
import { disposeOriginalCache } from "../sources/archives/originals";
import {disposeSearchWorkers} from '../search/qmd/runner';
export function dispose() { disposeOriginalCache();disposeSearchWorkers(); }
export async function invoke(name: keyof ReturnType<typeof createRuntime>, input: unknown,signal?:AbortSignal) {
    const runtime = createRuntime(await loadConfig(),undefined,signal);
    return name === "list_sources" ? runtime.list_sources() : runtime[name](input);
}
