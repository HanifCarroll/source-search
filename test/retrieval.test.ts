import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultConfig, type Config } from "./helpers/config";
import { createRuntime } from "../src/application/runtime";
import { rebuildArchive } from "../src/sources/archives/index";
import {typedMessage} from "./helpers/messages";
import { decodeAttributedBody, messagesTimestampToIso } from "../src/sources/messages/reader";
import { searchMail } from "./helpers/mail";
import { querySchema } from "../src/domain/contracts";
import { queryKey, cursor } from "../src/domain/identity";
import { assertPacket } from "../src/domain/results";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let root: string, config: Config;
const task = (id: string, notes = "networking café\u2028with friends") => ({ uuid: id, title: "Synthetic history " + id, notes, status: "completed", trashed: false, start: "anytime", dates: { createdAt: "2024-01-01T00:00:00Z" }, tags: [] });
async function archive(tasks: ReturnType<typeof task>[]) {
  await writeFile(join(config.things, "tasks.jsonl"), tasks.map(t => JSON.stringify(t)).join("\n") + "\n");
  await writeFile(join(config.things, "context.json"), JSON.stringify({ TMTask: [{ uuid: "project", title: "Synthetic project", notes: "networking context", trashed: 0 }] }));
  await writeFile(join(config.things, "snapshot-info.json"), JSON.stringify({ exportedAt: "2026-10-11T00:00:00Z", taskCount: tasks.length }));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "source-search-test-"));
  config = { ...defaultConfig(), journals: join(root, "journal"), things: join(root, "things"), messages: join(root, "chat.db"), index: join(root, "index.sqlite") };
  await mkdir(join(config.journals, "2024/01-January"), { recursive: true }); await mkdir(config.things);
  await writeFile(join(config.journals, "2024/01-January/2024-01-01.md"), "Freeform networking journal with no frontmatter\n");
  await writeFile(join(config.journals, "index.md"), "networking navigation");
  await archive([task("a"), task("b")]);
  const db = new Database(config.messages);
  db.exec("CREATE TABLE message(guid TEXT,date INTEGER,is_from_me INTEGER,service TEXT,text TEXT,attributedBody BLOB,handle_id INTEGER,item_type INTEGER); CREATE TABLE chat(guid TEXT); CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER); CREATE TABLE handle(id TEXT);");
  db.query("INSERT INTO handle VALUES(?)").run("friend@example.test"); db.query("INSERT INTO chat VALUES(?)").run("test-chat");
  for (let i = 1; i <= 4; i++) { db.query("INSERT INTO message VALUES(?, ?, ?, 'iMessage', ?, ?, 1, 0)").run("message-" + i, 700_000_000_000_000_000n + BigInt(i), i === 1 ? 1 : 0, i === 2 || i === 3 ? null : "networking café " + i, i === 2 ? typedMessage("networking binary text") : i === 3 ? Buffer.from([0, 255, 1]) : null); db.query("INSERT INTO chat_message_join VALUES(1,?)").run(i); }
  db.close();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("original journals, historical project/task text and Unicode line separators stay readable", async () => {
  await rebuildArchive(config); const runtime = createRuntime(config);
  const result = await runtime.search_sources({ queries: [{ source: "journals", query: "networking" }, { source: "things-archive", query: "networking" }] });
  expect(result.results[0].items).toHaveLength(1); expect(result.results[1].items).toHaveLength(3);
  const read = await runtime.read_record({ ref: result.results[1].items.find(h => h.ref.id === "a")!.ref });
  expect(read.record.body).toContain("café\u2028with friends"); expect(read.record.metadata?.historical).toBe(true);
});

test("pagination reads the entire history without duplicates and scopes cursors to queries", async () => {
  await archive(Array.from({ length: 35 }, (_, i) => task("task-" + i)));
  await rebuildArchive(config); const runtime = createRuntime(config); const ids: string[] = []; let next: string | undefined;
  do { const p = (await runtime.search_sources({ queries: [{ source: "things-archive", query: "networking", limit: 7, cursor: next }] })).results[0]; expect(p.status).toBe("ok"); ids.push(...p.items.map(h => h.ref.id)); next = p.nextCursor; } while (next);
  expect(new Set(ids).size).toBe(36); expect(ids.length).toBe(36);
  const p = (await runtime.search_sources({ queries: [{ source: "things-archive", query: "networking", limit: 1 }] })).results[0];
  const wrong = (await runtime.search_sources({ queries: [{ source: "things-archive", query: "different", cursor: p.nextCursor }] })).results[0]; expect(wrong.error?.code).toBe("INVALID_CURSOR");
});

test("binary Messages are searchable, undecodable text is visible, context and authorship are retained", async () => {
  const before = await readFile(config.messages); const runtime = createRuntime(config);
  const first = (await runtime.search_sources({ queries: [{ source: "messages", query: "networking", limit: 1 }] })).results[0];
  const second = (await runtime.search_sources({ queries: [{ source: "messages", query: "networking", limit: 1, cursor: first.nextCursor }] })).results[0];
  expect(second.status).toBe("partial"); expect(second.items[0].ref.id).toBe("message-2"); expect(second.items[0].author).toBe("friend@example.test");
  const read = await runtime.read_record({ ref: second.items[0].ref, context: true }); expect(read.record.body).toContain("binary text"); expect(read.context.length).toBe(3);
  const own = await runtime.read_record({ ref: { source: "messages", id: "message-1" } }); expect(own.record.author).toBe("self");
  expect(await readFile(config.messages)).toEqual(before);
  expect(decodeAttributedBody(Buffer.from([0, 255, 1])).status).toBe("undecodable");
  expect(messagesTimestampToIso(700_000_000_000_000_000n)).toBe("2023-03-08T20:26:40.000Z");
});

test("path traversal, symlinks and stale references cannot read other files", async () => {
  const runtime = createRuntime(config);
  await expect(runtime.read_record({ ref: { source: "journals", id: "../../secret-2024-01-01.md" } })).rejects.toThrow();
  await symlink(join(config.journals, "2024/01-January/2024-01-01.md"), join(config.journals, "2024-01-02.md"));
  await expect(runtime.read_record({ ref: { source: "journals", id: "2024-01-02.md" } })).rejects.toThrow("links");
  const h = (await runtime.search_sources({ queries: [{ source: "journals", query: "networking" }] })).results[0].items[0];
  await writeFile(join(config.journals, h.ref.id), "changed text"); await expect(runtime.read_record({ ref: h.ref })).rejects.toThrow("changed");
  await symlink(config.messages, join(root, "linked.db"));
  const page = (await createRuntime({ ...config, messages: join(root, "linked.db") }).search_sources({ queries: [{ source: "messages", query: "x" }] })).results[0]; expect(page.error?.code).toBe("SOURCE_SYMLINK_REJECTED");
});

test("deleted archive records disappear after rebuild; failed refresh keeps the previous index", async () => {
  await rebuildArchive(config); const runtime = createRuntime(config); const before = await readFile(config.index);
  await writeFile(join(config.things, "tasks.jsonl"), "invalid json"); await expect(rebuildArchive(config)).rejects.toThrow(); expect(await readFile(config.index)).toEqual(before);
  await archive([task("a")]); await rebuildArchive(config);
  const page = (await runtime.search_sources({ queries: [{ source: "things-archive", query: "networking" }] })).results[0]; expect(page.items.some(h => h.ref.id === "b")).toBe(false);
  await expect(runtime.read_record({ ref: { source: "things-archive", id: "b" } })).rejects.toThrow("absent");
});

test("provider argument arrays cannot inject writes and Fastmail limitations remain explicit", async () => {
  const calls: string[][] = [];
  const execute = async (argv: string[]) => { calls.push(argv); return argv.includes("fastmail") ? [] : { messages: [{ id: "abc", subject: "x", from: "person@example.test", date: "2026-10-11", threadId: "def" }], nextPageToken: "token" }; };
  const page = await searchMail(querySchema.parse({ source: "mail-consulting", query: "--force $(evil)" }), execute);
  expect(calls[0].at(-2)).toBe("--"); expect(calls[0].at(-1)).toBe("-in:spam -in:trash --force $(evil)"); expect(calls[0]).toContain("--gmail-no-send"); expect(calls[0]).toContain("dev"); expect(page.nextCursor).toBeDefined();
  const runtime = createRuntime(config, execute);
  const result = await runtime.search_sources({ queries: [{ source: "mail-fastmail", query: "x", conversation: "thread" }, { source: "journals", query: "networking" }] });
  expect(result.results[0].error?.code).toBe("UNSUPPORTED_FILTER"); expect(result.results[1].items.length).toBe(1);
  await expect(runtime.search_sources({ queries: [{ source: "journals", query: "x", arbitrary: "field" }] })).rejects.toThrow();
  await expect(runtime.search_sources({ queries: [{ source: "journals", query: "x", from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }] })).rejects.toThrow();
});

test("Fastmail continuation retrieves every match once, supports different page sizes and ends cleanly", async () => {
  const records = Array.from({ length: 35 }, (_, i) => ({ message_id: "m" + i, subject: "Synthetic " + i, from: "friend@example.test" }));
  const calls: string[][] = [];
  const execute = async (argv: string[]) => {
    calls.push(argv); const offset = Number(argv[argv.indexOf("--position") + 1]), limit = Number(argv[argv.indexOf("--limit") + 1]);
    const messages = records.slice(offset, offset + limit), end = offset + messages.length;
    return { messages, position: offset, queryState: "stable", total: records.length, nextPosition: end < records.length ? end : null };
  };
  const query = { source: "mail-fastmail", query: "--force $(evil)" }, ids: string[] = []; let next: string | undefined;
  do {
    const page = await searchMail(querySchema.parse({ ...query, limit: ids.length ? 11 : 7, cursor: next }), execute);
    expect(page.status).toBe("ok"); ids.push(...page.items.map(h => h.ref.id)); next = page.nextCursor;
  } while (next);
  expect(ids).toEqual(records.map(m => m.message_id)); expect(new Set(ids).size).toBe(35);
  expect(calls.every(c => c.includes("--paged") && c.at(-2) === "--" && c.at(-1) === query.query)).toBe(true);
  const empty = await searchMail(querySchema.parse(query), async () => ({ messages: [], position: 0, queryState: "stable", total: 0, nextPosition: null }));
  expect(empty.status).toBe("ok"); expect(empty.nextCursor).toBeUndefined();
  const first = await searchMail(querySchema.parse({ ...query, limit: 7 }), execute);
  const afterHit = await searchMail(querySchema.parse({ ...query, cursor: first.items[2].cursorAfter }), execute);
  expect(afterHit.items[0].ref.id).toBe("m3");
  await expect(searchMail(querySchema.parse({ ...query, query: "different", cursor: first.nextCursor }), execute)).rejects.toThrow("does not belong");
});

test("Fastmail stale, malformed and inconsistent pages fail visibly alongside working sources", async () => {
  const q = querySchema.parse({ source: "mail-fastmail", query: "x" }), token = cursor(queryKey(q), JSON.stringify({ position: 1, state: "old" }));
  const stale = await createRuntime(config, async () => ({ messages: [], position: 1, queryState: "new", total: 0, nextPosition: null })).search_sources({ queries: [{ ...q, cursor: token }, { source: "journals", query: "networking" }] });
  expect(stale.results[0].error?.code).toBe("STALE_CURSOR"); expect(stale.results[1].items.length).toBe(1);
  await expect(searchMail({ ...q, cursor: cursor(queryKey(q), "invalid") }, async () => { throw Error("must not run"); })).rejects.toThrow("continuation");
  const valid = { messages: [{ message_id: "m1" }], position: 0, queryState: "state", total: 1, nextPosition: null };
  for (const bad of [{ ...valid, position: 1 }, { ...valid, total: 2 }, { ...valid, queryState: "" }, { ...valid, messages: [valid.messages[0], valid.messages[0]], total: 2 }, { ...valid, messages: [], total: 1 }]) {
    await expect(searchMail(q, async () => bad)).rejects.toThrow("Fastmail");
  }
});

test("combined response trimming retains Fastmail continuation after the last returned hit", async () => {
  for (let i = 2; i <= 25; i++) await writeFile(join(config.journals, `2024/01-January/2024-01-${String(i).padStart(2, "0")}.md`), "networking " + "x".repeat(600));
  const records = Array.from({ length: 35 }, (_, i) => ({ message_id: "m" + i, subject: "Synthetic " + i, snippet: "x".repeat(500), to: ["x".repeat(900)] }));
  const execute = async (argv: string[]) => {
    const offset = Number(argv[argv.indexOf("--position") + 1]), limit = Number(argv[argv.indexOf("--limit") + 1]);
    const messages = records.slice(offset, offset + limit), end = offset + messages.length;
    return { messages, position: offset, queryState: "stable", total: records.length, nextPosition: end < records.length ? end : null };
  };
  const result = await createRuntime(config, execute).search_sources({ queries: [{ source: "mail-fastmail", query: "x", limit: 25 }, { source: "journals", query: "networking", limit: 25 }] });
  expect(result.truncated).toBe(true); assertPacket(result);
  const mail = result.results[0]; expect(mail.status).toBe("ok"); expect(mail.items.length).toBeGreaterThan(0); expect(mail.items.length).toBeLessThan(25);
  const next = await searchMail(querySchema.parse({ source: "mail-fastmail", query: "x", cursor: mail.nextCursor }), execute);
  expect(next.items[0].ref.id).toBe("m" + mail.items.length);
});

test("long record reads continue without dropping text and packet budgets reject oversized output", async () => {
  const body = "networking " + "x".repeat(9988) + "😀" + "long private text ".repeat(4000); await writeFile(join(config.journals, "2024/01-January/2024-01-01.md"), body);
  const runtime = createRuntime(config); let next: string | undefined, complete = "";
  do { const response = await runtime.read_record({ ref: { source: "journals", id: "2024/01-January/2024-01-01.md" }, cursor: next }); expect(response.record.body).not.toMatch(/[\ud800-\udbff]$/u); complete += response.record.body; next = response.record.nextCursor; assertPacket(response); } while (next);
  expect(complete).toBe(body); expect(() => assertPacket({ data: "x".repeat(50_000) })).toThrow("budget");
});

test("local configuration rejects relative source paths", async () => {
  const old = process.env.SOURCE_SEARCH_CONFIG_FILE, path = join(root, "invalid-config.json"); await writeFile(path, JSON.stringify({ journals: "relative/root" })); process.env.SOURCE_SEARCH_CONFIG_FILE = path;
  try { await expect(loadConfig()).rejects.toThrow("absolute"); }
  finally { if (old === undefined) delete process.env.SOURCE_SEARCH_CONFIG_FILE; else process.env.SOURCE_SEARCH_CONFIG_FILE = old; }
});

test("mail context follows the selected message, handles the Fastmail envelope, and preserves a record on context failure", async () => {
  const summaries = Array.from({ length: 20 }, (_, i) => ({ summary: { message_id: "m" + i, subject: "Synthetic " + i }, body_text: "body " + i }));
  const execute = async (argv: string[]) => argv.includes("thread") ? { messages: summaries } : { summary: { message_id: "m15", subject: "Synthetic 15", thread_id: "thread" }, body_text: "original body" };
  const r = await createRuntime(config, execute).read_record({ ref: { source: "mail-fastmail", id: "m15" }, context: true });
  expect(r.context).toHaveLength(9); expect((r.context[0] as any).ref.id).toBe("m10"); expect(r.record.body).toBe("original body");
  const failedContext = async (argv: string[]) => { if (argv.includes("thread")) throw Error("source unavailable"); return execute(argv); };
  const partial = await createRuntime(config, failedContext).read_record({ ref: { source: "mail-fastmail", id: "m15" }, context: true });
  expect(partial.record.body).toBe("original body"); expect(partial.contextWarnings.length).toBe(1);
});

test("real MCP transport exposes only reads and returns the same substantive search as the CLI runtime", async () => {
  config.voiceNotes = join(root, "voice"); await mkdir(config.voiceNotes); await writeFile(join(config.voiceNotes, "2024-01-01 - Voice - Fixture.md"), "networking voice fixture");
  const configPath = join(root, "config.json"); await writeFile(configPath, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/mcp.ts")], env: { ...process.env as Record<string, string>, SOURCE_SEARCH_CONFIG_FILE: configPath }, stderr: "pipe" });
  const client = new Client({ name: "source-search-test", version: "1" });
  try {
    await client.connect(transport); const tools = await client.listTools(); expect(tools.tools.map(t => t.name).sort()).toEqual(["build_context", "list_context_entities", "list_sources", "read_record", "search_sources"]);
    expect(tools.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
    const response = await client.callTool({ name: "search_sources", arguments: { queries: [{ source: "journals", query: "networking" }] } });
    const data = JSON.parse((response.content as any[])[0].text); expect(data.results[0].items[0].ref.id).toBe("2024/01-January/2024-01-01.md");
    const schema = tools.tools.find(t => t.name === "search_sources")!.inputSchema as any;
    expect(schema.properties.queries.maxItems).toBe(100);
    const voice = await client.callTool({ name: "search_sources", arguments: { queries: [{ source: "voice-journals", query: "networking" }, { source: "chatgpt-archive", query: "x" }] } });
    const packet = JSON.parse((voice.content as any[])[0].text); expect(packet.results[0].items).toHaveLength(1); expect(packet.results[1].error.code).toBe("SOURCE_NOT_CONFIGURED");
    const opened = await client.callTool({ name: "read_record", arguments: { ref: packet.results[0].items[0].ref } }); expect(JSON.parse((opened.content as any[])[0].text).record.body).toContain("voice fixture");
    const updated = join(root, "updated-voice"); await mkdir(updated); await writeFile(join(updated, "2024-01-02 - Voice - New Fixture.md"), "fresh archive selection");
    await writeFile(configPath, JSON.stringify({ ...config, voiceNotes: updated }));
    const refreshed = await client.callTool({ name: "search_sources", arguments: { queries: [{ source: "voice-journals", query: "fresh" }] } });
    expect(JSON.parse((refreshed.content as any[])[0].text).results[0].items[0].ref.id).toBe("2024-01-02 - Voice - New Fixture.md");
    const invalid = await client.callTool({ name: "read_record", arguments: { ref: { source: "journals", id: "../outside-2024-01-01.md" } } }); expect(invalid.isError).toBe(true);
  } finally { await client.close(); }
});
