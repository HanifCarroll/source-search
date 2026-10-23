import type { Config } from "../../platform/config";
import { createCassProvider } from "../../vendor/cass/provider";
import type { CassRunner, CassSearchHit } from "../../vendor/cass/contracts";
import { fail, now, hash, queryKey, position, cursor, versioned } from "../../domain/identity";
import { querySchema, type Query, type Ref, type RecordData, type Page } from "../../domain/contracts";
import { hit } from "../../domain/results";
const provider = (c: Config, runner?: CassRunner) => createCassProvider({ binaryPath: c.cassBinary, dataDir: c.cassData, maxSnippetChars: 10000, searchTimeoutMs: 120000, slowSearchTimeoutMs: 120000, runner });
export async function cassStatus(c: Config, runner?: CassRunner) {
  const h = await provider(c, runner).health();
  return { available: h.readyForSearch, health: h, warnings: h.rebuilding && h.readyForSearch ? [h.stalled ? stalledWarning : refreshWarning] : [], coverage: "Local CASS conversation index", querySyntax: "CASS lexical, semantic or hybrid query (hybrid by default)", filters: ["from", "to"], dataDir: c.cassData };
}
const refreshWarning = "CASS refresh is running; searches use committed search assets. Results and pagination may change; retry if context reports a stale record.";
const stalledWarning = "CASS refresh is running but has reported no progress recently; searches use committed search assets. Results and pagination may change; retry if context reports a stale record.";
async function ready(c: Config, runner?: CassRunner) {
  const state = await cassStatus(c, runner);
  if (!state.available) fail("SOURCE_NOT_READY", state.health.rebuilding ? "CASS is rebuilding; wait for the existing job." : `CASS is ${state.health.index.stale ? "stale" : "not ready"}: ${state.health.errors.join("; ") || state.health.explanation || state.health.status || "readiness unknown"}. ${state.health.index.stale ? "Refresh the configured CASS index. " : ""}Data directory: ${c.cassData}`);
  return state.warnings;
}
function request(q: Query, native?: string) { return { query: q.query, limit: q.limit, cursor: native, since: q.from, until: q.to, mode: q.mode ?? "hybrid", source: "local" as const }; }
function fingerprint(h: CassSearchHit) { return hash(JSON.stringify(h)); }
export async function searchCass(c: Config, q: Query, runner?: CassRunner): Promise<Page> {
  q = { ...q, mode: q.mode ?? "hybrid" };
  if (q.conversation) fail("UNSUPPORTED_FILTER", "CASS does not accept conversation filters here");
  const refreshWarnings = await ready(c, runner);
  const token = position(q.cursor, queryKey(q)); if (token !== undefined && typeof token !== "string") fail("INVALID_CURSOR", "Expected CASS provider continuation");
  const result = await provider(c, runner).search(request(q, token as string | undefined));
  const warnings = [...result.warnings, ...refreshWarnings, "Existing CASS index; record reads return bounded source context rather than a complete session."];
  if (result.meta.fallbackReason || result.meta.searchMode && result.meta.searchMode !== q.mode) warnings.push(`Requested ${q.mode}; CASS used ${result.meta.searchMode || "unknown"}: ${result.meta.fallbackReason || "provider fallback"}`);
  if (result.budget.timedOut || result.hitsClamped) warnings.push("CASS results were limited by its query budget");
  return { retrieval: { requestedMode: q.mode!, effectiveMode: result.meta.searchMode, fallbackReason: result.meta.fallbackReason }, source: q.source, status: result.budget.timedOut || result.hitsClamped || !!result.meta.fallbackReason || !!result.meta.searchMode && result.meta.searchMode !== q.mode ? "partial" : "ok", items: result.hits.map((h, index) => {
    const id = Buffer.from(JSON.stringify({ q: { ...q, cursor: undefined }, native: token, result: index + 1, fingerprint: fingerprint(h) })).toString("base64url");
    const r = versioned({ ref: { source: q.source, id }, title: h.title || h.provenance.agent + " conversation", body: h.snippet || "", type: "agent-conversation-hit", author: h.provenance.agent, observedAt: now(), locator: h.provenance.sourcePath + (h.provenance.lineNumber ? "#message=" + h.provenance.lineNumber : ""), metadata: { previewOnly:true,provenance: h.provenance, score: h.score }, occurredAt: h.provenance.createdAt != null && Number.isFinite(new Date(h.provenance.createdAt).getTime()) ? new Date(h.provenance.createdAt).toISOString() : undefined });
    return hit(r, q, "retry-smaller-page");
  }), ...(result.nextCursor ? { nextCursor: cursor(queryKey(q), result.nextCursor) } : {}), warnings, observedAt: now() };
}
export async function readCass(c: Config, ref: Ref, context: boolean, runner?: CassRunner): Promise<RecordData> {
  let value: any, q: Query;
  try { value = JSON.parse(Buffer.from(ref.id, "base64url").toString()); q = querySchema.parse({ ...value.q, mode: value.q.mode ?? "lexical" }); if (q.source !== "agent-history" || q.cursor || !Number.isSafeInteger(value.result) || value.result < 1 || value.result > q.limit || typeof value.fingerprint !== "string" || (value.native !== undefined && typeof value.native !== "string")) throw Error(); } catch { fail("INVALID_REFERENCE", "Invalid CASS query-bound reference"); }
  const refreshWarnings = await ready(c, runner); const p = provider(c, runner);
  const data = await p.context({ ...request(q!, value.native), result: value.result, context: context ? 5 : 0 });
  if (fingerprint(data.hit) !== value.fingerprint) fail("STALE_RECORD", "CASS result changed during the context read");
  const selected=data.hit;
  return { ref, title: selected.title || "Agent conversation", body: data.lines.map(l => `${l.line}: ${l.content}`).join("\n"), type: "agent-conversation-context", observedAt: now(), locator: data.path + "#message=" + data.targetLine, metadata: { provenance: selected.provenance, totalLines: data.totalLines, returnedLines: data.lines.length, sourceExists: data.sourceExists, archiveOnly: data.archiveOnly }, warnings: [...refreshWarnings, "Bounded CASS context; numbers identify canonical messages, not physical file lines. Each message is capped at 10,000 characters. This is not a full-session export."] };
}
