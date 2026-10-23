import { readdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
// Keep the MCP transport alive while loading one bundled runtime revision at a time.
export function runtimeLoader(entry = join(import.meta.dir, "../application/api.ts")) {
    let revision = "", module: typeof import("../application/api") | undefined;
    const outputDirectories:string[]=[];
    process.once("exit", () => {for(const directory of outputDirectories)rmSync(directory, { recursive: true, force: true });});
    let loading: Promise<typeof import("../application/api")> | undefined;
    return async function load() {
        if (loading)
            return loading;
        loading = (async () => {
            const digest = createHash("sha256");
            async function walk(root: string) {
                for (const d of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
                    const path = join(root, d.name);
                    if (d.isDirectory())
                        await walk(path);
                    else if (d.isFile() && /\.(?:ts|mjs|mts)$/.test(d.name)) {
                        digest.update(path);
                        digest.update(await readFile(path));
                    }
                }
            }
            await walk(entry === join(import.meta.dir, "../application/api.ts") ? join(import.meta.dir, "..") : dirname(entry));
            const packageRoot=entry===join(import.meta.dir,"../application/api.ts") ? join(import.meta.dir,"../..") : dirname(entry);
            for(const name of ["package.json","bun.lock"]){
                try{digest.update(name);digest.update(await readFile(join(packageRoot,name)));}
                catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
            }
            const current = digest.digest("hex");
            if (module && current === revision)
                return module;
            const build = await Bun.build({ entrypoints: [entry], target: "bun" }).catch(error => { throw Error("Source Search update could not load; correct the code and retry. " + String(error.message).slice(0, 500)); });
            if (!build.success)
                throw Error("Source Search update could not load; correct the code and retry. " + build.logs.map(l => l.message).join("; "));
            const code = await build.outputs[0].text();
            // A fresh directory avoids Bun's cached directory resolution after the first bundle is loaded.
            const outputDirectory=await mkdtemp(join(tmpdir(), "source-search-runtime-"));outputDirectories.push(outputDirectory);
            const path = join(outputDirectory, current + ".mjs");
            await writeFile(path, code, { mode: 0o600 });
            let updated: typeof import("../application/api");
            // Bun may lazily resolve bundled imports; retain code until the transport exits.
            try {
                updated = await import(pathToFileURL(path).href);
            }
            catch (error) {
                await rm(path, { force: true });
                throw error;
            }
            if (typeof updated.invoke !== "function")
                throw Error("Runtime update lacks its read interface");
            module?.dispose?.();
            module = updated;
            revision = current;
            return updated;
        })().finally(() => loading = undefined);
        return loading;
    };
}
