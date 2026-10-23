import type { Config } from "../../platform/config";
import { fail } from "../../domain/identity";
import worker from "./hybrid.mjs" with { type: "text" };

export type QmdRequest = {
  index: "vault" | "library";
  mode: "lexical" | "semantic" | "hybrid";
  query: string;
  collection?: string;
};
export type QmdRun = (request: QmdRequest) => Promise<unknown>;
export const runQmd = async (request: QmdRequest, config: Config): Promise<unknown> => {
  const library = request.index === "library";
  const input = request.mode === "hybrid" ? JSON.stringify({
    packagePath:config.qmdPackage, models:config.qmdModels,
    database:library ? config.libraryDatabase : config.qmdDatabase,
    query:request.query, collection:request.collection,
  }) : undefined;
  const command = input
    ? [config.nodeBinary, "--input-type=module", "--eval", worker + "\nawait main();"]
    : [config.qmdBinary, "--index", library ? config.libraryIndex : config.qmdIndex,
       request.mode === "lexical" ? "search" : "vsearch", "--json", "-n", "100",
       ...(request.collection ? ["-c",request.collection] : []), "--",request.query];
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
