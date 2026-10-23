import type { Config } from "../../platform/config";
import { fail } from "../../domain/identity";
import worker from "./hybrid.mjs" with { type: "text" };

export type QmdRun = (argv: string[]) => Promise<unknown>;
export const runQmd = async (argv: string[], config: Config): Promise<unknown> => {
  const hybrid = argv[3] === "query";
  const collectionIndex = argv.indexOf("-c");
  const input = hybrid ? JSON.stringify({packagePath:config.qmdPackage, models:config.qmdModels, database:argv[2] === config.libraryIndex ? config.libraryDatabase : config.qmdDatabase, query:argv.at(-1), collection:collectionIndex < 0 ? undefined : argv[collectionIndex+1]}) : undefined;
  const command = hybrid ? [config.nodeBinary, "--input-type=module", "--eval", worker + "\nawait main();"] : argv;
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: input ? new Blob([input]) : "ignore", env:{...process.env, HF_HUB_OFFLINE:"1"} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const part of stream) { bytes += part.length; if (bytes > 4 * 1024 * 1024) { child.kill(); fail("OUTPUT_LIMIT", "QMD output exceeded its budget"); } chunks.push(part); }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    return await Promise.race([
      (async () => { const [out, , code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]); if (code) fail("QMD_FAILED", `QMD exited with code ${code}; no keyword fallback was substituted`); try { return JSON.parse(out); } catch { fail("INVALID_PROVIDER_RESPONSE", "QMD did not return JSON"); } })(),
      new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("QMD exceeded 240 seconds; retry or choose lexical mode"), { code: "TIMEOUT" })); }, 240_000); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
};
