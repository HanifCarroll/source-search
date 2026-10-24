import { loadConfig } from "../platform/config";
import { createRuntime } from "./runtime";
import { disposeOriginalCache } from "../sources/archives/originals";
export function dispose() { disposeOriginalCache(); }
export async function invoke(name: keyof ReturnType<typeof createRuntime>, input: unknown) {
    const runtime = createRuntime(await loadConfig());
    return name === "list_sources" ? runtime.list_sources() : runtime[name](input);
}
