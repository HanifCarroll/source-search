import {sourceKind} from '../../domain/source-catalog';
import {mailAccount, defaultConfig, requireSource, type Config} from "../../platform/config";
import { readableMail } from "../../domain/presentation";
import { words } from "../../domain/query";
import { fail, now, versioned, queryKey, cursor, position } from "../../domain/identity";
import { hit } from "../../domain/results";
import { type Query, type Page, type RecordData } from "../../domain/contracts";

export type Run = (argv: string[]) => Promise<unknown>;
export type PreviewBudget = { remaining: number; records: Map<string,RecordData> };
export const run: Run = async argv => {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const readBounded = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4 * 1024 * 1024) { process.kill(); fail("OUTPUT_LIMIT", "Mail command exceeded its output budget"); } chunks.push(value); }
          return Buffer.concat(chunks).toString("utf8");
        };
        const [stdout, , code] = await Promise.all([readBounded(process.stdout), readBounded(process.stderr), process.exited]);
        if (code) fail("MAIL_COMMAND_FAILED", `Read-only mail command exited with code ${code}; check the existing tool's account access`);
        try { return JSON.parse(stdout); } catch { return fail("INVALID_PROVIDER_RESPONSE", "Mail command did not return JSON"); }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { process.kill(); reject(Object.assign(new Error("Mail read timed out"), { code: "TIMEOUT" })); }, 30_000); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
};
export type MailSource = string;
function accountFor(config:Config,source:MailSource){
  requireSource(config,source);
  const account=mailAccount(config,source);
  if(!account)fail("SOURCE_NOT_CONFIGURED","Configure an account for this mail source");
  return account;
}
function providerId(id: string) { if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail("INVALID_REFERENCE", "Invalid provider record identifier"); return id; }
export async function searchMail(q: Query, execute: Run = run, previews:PreviewBudget = {remaining:3,records:new Map()}, config:Config = defaultConfig()): Promise<Page> {
  const source = q.source as MailSource, account = accountFor(config,source);
  q={...q,excludeSpamTrash:q.excludeSpamTrash!==false};
  const fastmail = sourceKind(source,config) === "fastmail", key = queryKey(q), page = position(q.cursor, key);
  if (q.conversation) fail("UNSUPPORTED_FILTER", "Use read_record with context to open the mail thread");
  if (page !== undefined && typeof page !== "string") fail("INVALID_CURSOR", "Expected a provider page token");
  let continuation: { position: number; state: string } | undefined;
  if (fastmail && page !== undefined) {
    try {
      continuation = JSON.parse(page as string);
      if (!continuation || !Number.isSafeInteger(continuation.position) || continuation.position < 1 || typeof continuation.state !== "string" || !continuation.state.length || continuation.state.length > 1000) throw Error();
    } catch { fail("INVALID_CURSOR", "Invalid Fastmail continuation"); }
  }
  let query = q.query;
  if(q.match) query=q.match === "phrase" ? '"'+q.query.replaceAll('"','')+'"' : words(q.query).map(w=>'"'+w+'"').join(" ");
  if(!fastmail && q.excludeSpamTrash!==false) query="-in:spam -in:trash "+query;
  if(!fastmail && q.folders?.length) query="{"+q.folders.map(f=>'label:"'+f.replaceAll('"','')+'"').join(" ")+"} "+query;
  if (!fastmail && q.from) query += ` after:${Math.floor(Date.parse(q.from) / 1000)}`;
  if (!fastmail && q.to) query += ` before:${Math.floor(Date.parse(q.to) / 1000)}`;
  if (q.conversation) fail("UNSUPPORTED_FILTER", "Use read_record with context to open the mail thread");
  const argv = fastmail
    ? [config.mailbridgeBinary, "--json", "search", "--account", account.account, "--paged", "--position", String(continuation?.position || 0), "--limit", String(q.limit), ...(q.from?["--after",q.from]:[]), ...(q.to?["--before",q.to]:[]), ...(q.folders||[]).flatMap(f=>["--folder",f]), ...(q.excludeSpamTrash!==false?["--exclude-spam-trash"]:[]), ...(q.sort === "oldest"?["--oldest"]:[]), "--", query]
    : [config.gmailBinary, "gmail", "messages", "search", "--account", account.account, "--gmail-no-send", "--json", "--no-input", "--timezone", "UTC", "--max", String(q.limit), ...(page ? ["--page", page] : []), "--", query];
  const data = await execute(argv) as any, observedAt = now();
  const messages = data.messages;
  if (!Array.isArray(messages)) fail("INVALID_PROVIDER_RESPONSE", "Missing mail search records");
  if (fastmail) {
    const offset = continuation?.position || 0, end = offset + messages.length;
    if (continuation && typeof data.queryState === "string" && data.queryState !== continuation.state) fail("STALE_CURSOR", "Fastmail search results changed; restart this query without its cursor");
    if (data.position !== offset || typeof data.queryState !== "string" || !data.queryState.length || data.queryState.length > 1000 || !Number.isSafeInteger(data.total) || data.total < 0 || messages.length > q.limit || (messages.length && end > data.total) || (!messages.length && offset < data.total) || data.nextPosition !== (end < data.total ? end : null)) fail("INVALID_PROVIDER_RESPONSE", "Invalid Fastmail page metadata");
    if (new Set(messages.map((m: any) => m.message_id)).size !== messages.length) fail("INVALID_PROVIDER_RESPONSE", "Fastmail returned duplicate records in a page");
  }
  const warnings = fastmail ? ["Continue with nextCursor until it is absent; changed search results require a restart."] : [];
  const next = fastmail ? (data.nextPosition !== null ? cursor(key, JSON.stringify({ position: data.nextPosition, state: data.queryState })) : undefined) : (data.nextPageToken ? cursor(key, String(data.nextPageToken)) : undefined);
  if(!fastmail)for(const m of messages){const id=source+":"+m.id;if(!m.snippet && !m.body && !previews.records.has(id) && previews.remaining>0){previews.remaining--;try{previews.records.set(id,await readMail(source,m.id,execute,config));}catch{warnings.push(`Preview unavailable for ${m.id}; open its reference to retry`);}}}
  const items = messages.slice(0, q.limit).map((m: any, index: number) => {
    const id = providerId(fastmail ? m.message_id : m.id);
    if(previews.records.has(source+":"+id))return hit(previews.records.get(source+":"+id)!,q,String(page || ""));
    return hit({ adapter:sourceKind(source,config),ref: { source, id }, title: m.subject || "(No subject)", body: m.snippet || m.body || "", type: "email", locator: `source-search://${source}/${id}`, observedAt,
      author: String(m.from || "unknown").slice(0, 500), occurredAt: mailDate(m.date,fastmail),
      conversation: m.thread_id || m.threadId, metadata: { previewOnly:true,dateKind:fastmail ? "provider-received-at" : "provider-message-date", direction:mailDirection(m.labels,m.folders), account: account.email, to: m.to || [], labels: m.labels || [], folders:m.folders || [], messageId:m.message_id_header } }, q, fastmail ? JSON.stringify({ position: data.position + index + 1, state: data.queryState }) : String(page || ""));
  });
  return { source, status: "ok", totalMatches:fastmail?data.total:undefined, items, ...(next ? { nextCursor: next } : {}), warnings, observedAt };
}
export async function readMail(source: MailSource, id: string, execute: Run = run, config:Config = defaultConfig()): Promise<RecordData> {
  const account=accountFor(config,source); providerId(id); const fastmail = sourceKind(source,config) === "fastmail";
  const data = await execute(fastmail ? [config.mailbridgeBinary, "--json", "read", "--account", account.account, "--message-id", id]
    : [config.gmailBinary, "gmail", "get", id, "--account", account.account, "--gmail-no-send", "--json", "--no-input"]) as any;
  const summary = fastmail ? data.summary : data.headers;
  if (!summary || (fastmail ? summary.message_id : data.message?.id) !== id) fail("INVALID_PROVIDER_RESPONSE", "Provider returned a different or missing mail record");
  const body = readableMail((fastmail ? (data.body_text || data.body_html) : data.body) || "");
  const date=mailDate(summary.date,true),internal=new Date(Number(data.message?.internalDate));
  const occurredAt=date || (!fastmail && Number.isFinite(internal.getTime()) ? internal.toISOString() : undefined);
  return versioned({ adapter:sourceKind(source,config),ref: { source, id }, title: summary.subject || "(No subject)", body: body || "", type: "email", observedAt: now(), locator: `source-search://${source}/${id}`,
    author: summary.from || "unknown", occurredAt,
    conversation: fastmail ? summary.thread_id : data.message.threadId,
    metadata: { dateKind:fastmail ? (date ? "provider-received-at" : "unknown") : date ? "message-date-header" : occurredAt ? "provider-internal-date" : "unknown", direction:mailDirection(data.message?.labelIds,summary.folders), account: account.email, to: summary.to, cc: summary.cc, bodyFormat:"text", folders:summary.folders || [], labels:data.message?.labelIds || [], messageId:summary["message-id"] || summary.messageId, attachments: fastmail ? data.attachments?.map((a: any) => ({ name: a.filename, type: a.mime_type })) : undefined },
    warnings: ["Attachment reading is outside this first text-retrieval version.", ...(fastmail ? ["Existing Fastmail tool caps each body value at 2 MB; very large message bodies may be incomplete."] : [])] });
}
export async function mailContext(record: RecordData, execute: Run = run, config:Config = defaultConfig()) {
  const account=accountFor(config,record.ref.source as MailSource);
  if (!record.conversation) return { records: [], warnings: ["Provider did not return a thread identifier"] };
  const source = record.ref.source as MailSource, fastmail = sourceKind(source,config) === "fastmail";
  if (fastmail) {
    const raw = await execute([config.mailbridgeBinary, "--json", "thread", "--account", account.account, "--thread-id", providerId(record.conversation), "--scan-limit", "200"]) as any;
    if (!Array.isArray(raw.messages)) fail("INVALID_PROVIDER_RESPONSE", "Missing mail thread list");
    const neighbors = nearby(raw.messages, record.ref.id, m => m.summary?.message_id);
    return { records: neighbors.map(m => ({ ref: { source, id: m.summary.message_id }, excerpt: readableMail(String(m.body_text || m.summary.snippet || "")).slice(0, 500), title: m.summary.subject })), warnings: [...(raw.partial ? ["Thread lookup used a bounded recent-message fallback; context may be incomplete."] : []), "Context shows up to five neighbors on each side."] };
  }
  const raw = await execute([config.gmailBinary, "gmail", "thread", "get", providerId(record.conversation), "--account", account.account, "--gmail-no-send", "--json", "--no-input"]) as any;
  const messages = raw.thread?.messages || raw.messages;
  if (!Array.isArray(messages)) fail("INVALID_PROVIDER_RESPONSE", "Missing Gmail thread messages");
  return { records: nearby(messages, record.ref.id, m => m.id).map((m: any) => ({ ref: { source, id: m.id }, excerpt: String(m.snippet || "").slice(0, 500), occurredAt: new Date(Number(m.internalDate)).toISOString() })), warnings: messages.length > 11 ? ["Context shows up to five neighbors on each side; open individual references for complete bodies."] : [] };
}
function nearby(messages: any[], id: string, getId: (m: any) => string) {
  const i = messages.findIndex(m => getId(m) === id);
  if (i < 0) fail("PARTIAL_CONTEXT", "Selected record is absent from the returned thread");
  return [...messages.slice(Math.max(0, i - 5), i), ...messages.slice(i + 1, i + 6)];
}

function mailDate(value:unknown,hasZone:boolean) {
  if(typeof value!=="string" || !value)return undefined;
  const text=!hasZone && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ? value.replace(" ","T")+":00Z" : value;
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}

function mailDirection(labels: string[] = [], folders: {role?:string}[] = []) {
  return labels.includes("SENT") || folders.some(f=>f.role === "sent") ? "outgoing" : "unknown";
}
