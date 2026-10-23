import { readdir, lstat } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import type { Config } from "../../platform/config";
import { fail, now, assertVersion, versioned } from "../../domain/identity";
import { contained, textFile } from "../../platform/source-files";
import { type Ref, type RecordData, type Query } from "../../domain/contracts";
import { recordPage } from "../../domain/pages";

export async function sourceFiles(root: string, accept: (name: string) => boolean) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH", "Source root must be an ordinary directory");
  const paths: string[] = [], warnings: string[] = []; let count = 0;
  async function walk(folder: string, depth: number) {
    if (depth > 40) fail("SOURCE_LIMIT", "Source nesting exceeds the discovery budget");
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++count > 20_000) fail("SOURCE_LIMIT", "Source discovery exceeds the file budget");
      if (entry.isSymbolicLink()) { warnings.push("Source links are not followed"); continue; }
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && accept(entry.name)) paths.push(relative(root, path));
    }
  }
  await walk(root, 0); return { paths: paths.sort(), warnings: [...new Set(warnings)] };
}
function root(config: Config, source: Ref["source"]) { return source === "voice-journals" ? config.voiceNotes : config.callNotes; }
const note = (name: string, source: Ref["source"]) => source === "voice-journals" ? /^\d{4}-\d{2}-\d{2} - Voice - .+\.md$/.test(name) : name.endsWith(".md") && !["AGENTS.md", "index.md", "README.md"].includes(name);
export async function notesStatus(config: Config, source: Ref["source"]) { const d = await sourceFiles(root(config, source), name => note(name, source)); return { records: d.paths.length, warnings: d.warnings, coverage: "Current retained Markdown notes; reviewed transcripts and source warnings stay intact" }; }
export async function readNote(config: Config, ref: Ref): Promise<RecordData> {
  if (!note(basename(ref.id), ref.source)) fail("INVALID_REFERENCE", "Expected a retained transcript note");
  const path = await contained(root(config, ref.source), ref.id), body = await textFile(path);
  const field = (name: string) => new RegExp(`^${name}:\\s*["']?([^"'\\n]+)`, "m").exec(body.startsWith("---") ? body.split("---")[1] : "")?.[1]?.trim();
  const date = field("source_started_at") || field("date"), occurredAt = date && Number.isFinite(Date.parse(date)) ? /^\d{4}-\d{2}-\d{2}$/.test(date) ? date + "T00:00:00-03:00" : new Date(date).toISOString() : undefined;
  const r = versioned({ ref: { source: ref.source, id: ref.id }, body, title: basename(ref.id, ".md"), type: "reviewed-transcript-note", locator: path, occurredAt, observedAt: now(),
    metadata: { transcription: true, muesliMeetingId: field("source") === "muesli" && /^\d+$/.test(field("muesli_meeting_id") || "") ? field("muesli_meeting_id") : undefined, sourceLocator: field("source_audio") || field("source_locator"), backend: field("backend"), model: field("model"), datePrecision: date?.length === 10 ? "day" : "timestamp" }, warnings: ["This is the retained source note, not newly transcribed audio; its original quality warnings remain in the text."] });
  assertVersion(ref, r.ref.version!); return r;
}
export async function searchNotes(config: Config, q: Query) {
  if (q.conversation) fail("UNSUPPORTED_FILTER", "Transcript notes do not have native conversation filters");
  const d = await sourceFiles(root(config, q.source), name => note(name, q.source)), records: RecordData[] = [];
  // shortcut: retained notes are small; use bounded direct reads until measured volume warrants an index.
  if (d.paths.length > 1000) fail("SOURCE_LIMIT", "More than 1,000 transcript notes require a dedicated index");
  for (const id of d.paths) { try { records.push(await readNote(config, { source: q.source, id })); } catch { d.warnings.push("A source note could not be read; coverage is incomplete"); } }
  records.sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || "") || a.ref.id.localeCompare(b.ref.id));
  return recordPage(records, q, [...new Set(d.warnings)]);
}
