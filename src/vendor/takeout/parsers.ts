import { createHash } from "node:crypto";
import type { Participant, SourceItemDraft } from "../source-types";
import type {
  ArchiveOnlyTakeoutCapture,
  ClassifiedTakeoutEntry,
  ParsedTakeoutEntry,
  ParsedTakeoutEntryKind,
  TakeoutEntryContext,
} from "./contracts";
import type { SafeZipEntry } from "./zip";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const tolerantUtf8Decoder = new TextDecoder("utf-8");

export function classifyTakeoutEntry(entry: SafeZipEntry): ClassifiedTakeoutEntry {
  const path = entry.path.replace(/^Takeout\//i, "");
  const lower = path.toLowerCase();
  if (entry.isDirectory) return { entry, kind: "ignored-unsupported" };
  if (hasPathSegment(lower, "drive")) return { entry, kind: "ignored-out-of-scope" };
  if (lower.endsWith("/all mail including spam and trash.mbox") || lower === "all mail including spam and trash.mbox") {
    return { entry, kind: "mailbox" };
  }
  if (isAdministrativeSettings(lower)) return { entry, kind: "settings" };
  if (isYouTubeHistory(lower)) return { entry, kind: "youtube-html" };
  if (isYouTubeCsv(lower)) return { entry, kind: "youtube-csv" };
  if (lower.endsWith(".ics") && hasPathSegment(lower, "calendar")) return { entry, kind: "calendar" };
  if (hasPathSegment(lower, "search contributions") && lower.endsWith(".json")) {
    return { entry, kind: "search-contributions" };
  }
  if (isMapsPath(lower) && lower.endsWith(".json")) return { entry, kind: "maps-json" };
  if (isMapsPath(lower) && lower.endsWith(".csv")) return { entry, kind: "maps-csv" };
  return { entry, kind: "ignored-unsupported" };
}

export function parseTakeoutEntry(
  classified: ClassifiedTakeoutEntry,
  bytes: Uint8Array,
  context: TakeoutEntryContext,
  mailboxMessageIndex?: number,
): ParsedTakeoutEntry {
  switch (classified.kind) {
    case "mailbox":
      return { items: parseMailbox(bytes, context, mailboxMessageIndex) };
    case "settings":
      return { items: [], archiveOnly: parseAdministrativeSettings(bytes, context) };
    case "youtube-html":
      return { items: parseYouTubeHistoryHtml(bytes, context) };
    case "youtube-csv":
      return { items: parseYouTubeCsv(bytes, context) };
    case "calendar":
      return { items: parseCalendar(bytes, context) };
    case "maps-json":
      return parseJsonProjectionOrArchive("Maps", bytes, context, parseMapsJson);
    case "maps-csv":
      return { items: parseMapsCsv(bytes, context) };
    case "search-contributions":
      return parseJsonProjectionOrArchive("Search Contributions", bytes, context, parseSearchContributions);
    case "ignored-out-of-scope":
      return { items: [], warning: `Ignored out-of-scope Google Takeout entry ${context.entry.path}.` };
    case "ignored-unsupported":
      return { items: [], warning: `Ignored unsupported Google Takeout entry ${context.entry.path}.` };
  }
}

function parseJsonProjectionOrArchive(
  label: string,
  bytes: Uint8Array,
  context: TakeoutEntryContext,
  parse: (bytes: Uint8Array, context: TakeoutEntryContext) => SourceItemDraft[],
): ParsedTakeoutEntry {
  if (isBlankJsonDocument(bytes)) return { items: [] };
  try {
    return { items: parse(bytes, context) };
  } catch (error) {
    const message = errorMessage(error);
    if (!message.startsWith("Malformed JSON in ")) throw error;
    return {
      items: [],
      incomplete: { entryPath: context.entry.path, reason: "malformed-json" },
      warning: `${label} entry ${context.entry.path} contains malformed JSON. Its raw bytes were archived without a searchable projection.`,
      archiveOnly: {
        connectorId: "google-takeout-archive",
        sourceKind: "google-takeout",
        sourceAccountId: context.sourceAccountId,
        sourceRecordId: context.entry.entryId,
        captureType: "google-takeout-malformed-json",
        schemaVersion: "google-takeout-v1",
        raw: {
          archive: archiveProvenance(context),
          entry: entryProvenance(context),
          parseError: message,
          contentBase64: toBase64(bytes),
        },
        metadata: {
          provenance: archiveProvenance(context),
          projection: {
            mode: "archive-only",
            searchable: false,
            defaultSearchable: false,
            semanticSearchable: false,
            reason: "malformed-json",
          },
        },
      },
    };
  }
}

function isBlankJsonDocument(bytes: Uint8Array): boolean {
  let index = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return false;
  }
  return true;
}

export function isAdministrativeSettings(path: string): boolean {
  const basename = path.split("/").at(-1) ?? "";
  return (
    basename === "settings.json" ||
    basename === "gmail settings.json" ||
    basename === "meet_settings.json" ||
    (hasPathSegment(path, "mail") && basename.endsWith("settings.json")) ||
    (hasPathSegment(path, "mail") && hasPathSegment(path, "user settings") && basename.endsWith(".json"))
  );
}

function isYouTubeHistory(path: string): boolean {
  const inYouTube = hasPathSegment(path, "youtube and youtube music") || path.startsWith("youtube/");
  return inYouTube && (path.endsWith("watch-history.html") || path.endsWith("search-history.html"));
}

function isYouTubeCsv(path: string): boolean {
  const inYouTube = hasPathSegment(path, "youtube and youtube music") || path.startsWith("youtube/");
  if (!inYouTube || !path.endsWith(".csv")) return false;
  return /(subscription|channel|playlist)/.test(path);
}

function parseAdministrativeSettings(bytes: Uint8Array, context: TakeoutEntryContext): ArchiveOnlyTakeoutCapture {
  const text = decodeUtf8(bytes, context.entry.path).replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed administrative JSON in ${context.entry.path}: ${errorMessage(error)}`);
  }
  return {
    connectorId: "google-takeout-archive",
    sourceKind: "google-takeout",
    sourceAccountId: context.sourceAccountId,
    sourceRecordId: context.entry.entryId,
    captureType: "google-takeout-administrative-settings",
    schemaVersion: "google-takeout-v1",
    raw: {
      archive: archiveProvenance(context),
      entry: entryProvenance(context),
      text,
      parsed,
      contentBase64: toBase64(bytes),
    },
    metadata: {
      provenance: archiveProvenance(context),
      projection: { mode: "archive-only", searchable: false, defaultSearchable: false, semanticSearchable: false },
      administrative: true,
    },
  };
}

function parseMailbox(bytes: Uint8Array, context: TakeoutEntryContext, only?:number): SourceItemDraft[] {
  if(only!==undefined && (!Number.isSafeInteger(only) || only<1 || only>200_000))throw Error("Invalid original mailbox message index");
  const text = tolerantUtf8Decoder.decode(bytes);
  const starts = [...text.matchAll(/^From [^\r\n]*(?:\r\n|\n|\r|$)/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) throw new Error(`Malformed MBOX ${context.entry.path}: no message separators found.`);
  const items: SourceItemDraft[] = [];
  const identities = new Map<string, number>();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? text.length;
    const rawMessage = text.slice(start, end);
    const separatorEnd = rawMessage.search(/\r?\n|\r/);
    if (separatorEnd < 0) throw new Error(`Malformed MBOX message ${index + 1} in ${context.entry.path}.`);
    const separator = rawMessage.slice(0, separatorEnd);
    const message = rawMessage.slice(separatorEnd + (rawMessage[separatorEnd] === "\r" && rawMessage[separatorEnd + 1] === "\n" ? 2 : 1));
    // Earlier headers determine duplicate Message-ID occurrences; MIME bodies need parsing only for the selected original.
    if(only!==undefined && index+1!==only){
      if(index+1>only)break;
      const boundary=message.search(/\r?\n\r?\n|\r\n?\r/);if(boundary<0)throw Error("Malformed mailbox message before selected record");
      const id=firstHeader(parseHeaders(message.slice(0,boundary),context.entry.path),"message-id")?.trim() || `sha256:${sha256(rawMessage)}`;
      identities.set(id,(identities.get(id) || 0)+1);continue;
    }
    const parsed = parseMailMessage(message, context.entry.path, index + 1);
    const identityBase = parsed.messageId ?? `sha256:${sha256(rawMessage)}`;
    const occurrence = (identities.get(identityBase) ?? 0) + 1;
    identities.set(identityBase, occurrence);
    const stableKey = `${identityBase}#${occurrence}`;
    const labels = parsed.labels;
    const isSpam = labels.some((label) => /(?:^|[\\/])spam$/i.test(label) || label.toLowerCase().includes("spam"));
    const isTrash = labels.some((label) => /(?:^|[\\/])trash$/i.test(label) || label.toLowerCase().includes("trash"));
    const archiveOnly = isSpam || isTrash;
    const projection = archiveOnly
      ? { mode: "archive-only", searchable: false, defaultSearchable: false, semanticSearchable: false, reason: "gmail-spam-or-trash" }
      : { mode: "full", searchable: true, defaultSearchable: true, semanticSearchable: true };
    const contentText = [
      parsed.subject,
      parsed.from ? `From: ${parsed.from}` : undefined,
      parsed.to.length ? `To: ${parsed.to.join(", ")}` : undefined,
      parsed.bodyText,
    ].filter(Boolean).join("\n");
    const sourceItemId = itemId(context, "email", stableKey);
    const sourceRecord = {
      messageIndex: index + 1,
      separator,
      rawMessage,
      headers: parsed.headers,
      messageId: parsed.messageId,
      labels,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
    };
    items.push(makeItem(context, {
      sourceItemId,
      logicalId: `${context.entry.entryId}/email/${stableKey}`,
      itemType: "email",
      title: parsed.subject || parsed.from || "Email",
      contentText: contentText || parsed.subject || "Email",
      participants: parsed.participants,
      ...(parsed.occurredAt ? { occurredAt: parsed.occurredAt } : {}),
      metadataExtra: parsed.warnings.length ? { mimeWarnings: parsed.warnings } : undefined,
      flags: {
        gmail: true,
        fullReconciliation: true,
        ...(isSpam ? { isSpam: true } : {}),
        ...(isTrash ? { isTrash: true } : {}),
      },
      projection,
      sourceRecord,
      ...(parsed.dateValue ? { timelineSource: parsed.dateValue } : {}),
      captureType: "google-takeout-email",
    }));
  }
  return items;
}

type ParsedMailMessage = {
  headers: Record<string, string[]>;
  subject: string;
  from: string;
  to: string[];
  labels: string[];
  messageId?: string;
  occurredAt?: Date;
  dateValue?: string;
  bodyText: string;
  warnings: string[];
  bodyHtml?: string;
  participants: Participant[];
};

function parseMailMessage(message: string, path: string, index: number): ParsedMailMessage {
  const separator = message.search(/\r?\n\r?\n|\r\n?\r/);
  if (separator < 0) throw new Error(`Malformed MBOX message ${index} in ${path}: missing header/body boundary.`);
  const boundaryLength = message[separator] === "\r" && message[separator + 1] === "\n" ? 4 : 2;
  const headerText = message.slice(0, separator);
  const body = message.slice(separator + boundaryLength);
  const headers = parseHeaders(headerText, path);
  const subject = decodeMimeHeader(firstHeader(headers, "subject") ?? "");
  const from = formatAddresses(parseAddressList(firstHeader(headers, "from") ?? ""));
  const toAddresses = [...parseAddressList(firstHeader(headers, "to") ?? ""), ...parseAddressList(firstHeader(headers, "cc") ?? "")];
  const to = toAddresses.map((address) => address.displayName ? `${address.displayName} <${address.id}>` : address.id);
  const labels = (firstHeader(headers, "x-gmail-labels") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
  const dateValue = firstHeader(headers, "date");
  const timestamp = dateValue ? Date.parse(dateValue) : Number.NaN;
  const warnings: string[] = [];
  const mime = parseMimeContent(headers, body, warnings);
  const participants = [
    ...parseAddressList(firstHeader(headers, "from") ?? "", "author"),
    ...toAddresses.map((address) => ({ ...address, role: "recipient" as const })),
  ];
  const messageIdHeader = firstHeader(headers, "message-id")?.trim();
  return {
    headers,
    subject,
    from,
    to,
    labels,
    ...(messageIdHeader ? { messageId: messageIdHeader } : {}),
    ...(Number.isFinite(timestamp) ? { occurredAt: new Date(timestamp) } : {}),
    ...(dateValue ? { dateValue } : {}),
    warnings,
    bodyText: mime.text,
    ...(mime.html ? { bodyHtml: mime.html } : {}),
    participants,
  };
}

function parseHeaders(text: string, path: string): Record<string, string[]> {
  const lines = text.split(/\r\n|\n|\r/);
  const headers: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (!current) throw new Error(`Malformed MBOX headers in ${path}: orphan continuation line.`);
      headers[current]![headers[current]!.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`Malformed MBOX headers in ${path}: ${line.slice(0, 40)}.`);
    current = line.slice(0, colon).trim().toLowerCase();
    (headers[current] ??= []).push(line.slice(colon + 1).trim());
  }
  if (Object.keys(headers).length === 0) throw new Error(`Malformed MBOX message in ${path}: no headers.`);
  return headers;
}

function parseMimeContent(headers: Record<string, string[]>, body: string, warnings: string[] = []): { text: string; html?: string } {
  const contentType = firstHeader(headers, "content-type") ?? "text/plain";
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType !== "text/plain" && mediaType !== "text/html" && !mediaType.startsWith("multipart/")) {
    return { text: "" };
  }
  const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.[1] ?? contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.[2];
  if (!boundary) {
    const decoded = decodeTransferEncoding(body, firstHeader(headers, "content-transfer-encoding"));
    return mediaType === "text/html" ? { text: stripHtml(decoded), html: decoded } : { text: decoded };
  }
  const parts = body.split(`--${boundary}`);
  const candidates: Array<{ text: string; html?: string; kind: "plain" | "html" }> = [];
  for (const part of parts.slice(1)) {
    if (part.startsWith("--")) continue;
    const boundaryIndex = part.search(/\r?\n\r?\n|\r\n?\r/);
    if (boundaryIndex < 0) { if (part.trim()) warnings.push("Incomplete MIME part: missing header/body boundary; original retained in archive"); continue; }
    const length = part[boundaryIndex] === "\r" && part[boundaryIndex + 1] === "\n" ? 4 : 2;
    let childHeaders: Record<string, string[]>;
    try { childHeaders = parseHeaders(part.slice(0, boundaryIndex), "MIME part"); }
    catch { warnings.push("Incomplete MIME part: malformed headers; original retained in archive"); continue; }
    const childBody = part.slice(boundaryIndex + length).replace(/\r?\n$/, "");
    if (/\battachment\b/i.test(firstHeader(childHeaders, "content-disposition") ?? "")) continue;
    const child = parseMimeContent(childHeaders, childBody, warnings);
    const childType = firstHeader(childHeaders, "content-type") ?? "text/plain";
    if (child.text.trim() && /^(?:text\/plain|text\/html|multipart\/[^;]+)(?:;|$)/i.test(childType.trim())) {
      candidates.push({ ...child, kind: /^text\/html(?:;|$)/i.test(childType.trim()) || child.html ? "html" : "plain" });
    }
  }
  const plain = candidates.find((candidate) => candidate.kind === "plain");
  const html = candidates.find((candidate) => candidate.kind === "html");
  return plain ?? html ?? { text: "" };
}

function decodeTransferEncoding(value: string, encoding: string | undefined): string {
  if (encoding?.toLowerCase() === "base64") {
    try {
      return tolerantUtf8Decoder.decode(Buffer.from(value.replace(/\s/g, ""), "base64"));
    } catch {
      throw new Error("Malformed base64 MIME body.");
    }
  }
  if (encoding?.toLowerCase() === "quoted-printable") return decodeQuotedPrintable(value);
  return value;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "=") {
      bytes.push(value.charCodeAt(index) & 0xff);
      continue;
    }
    if (value[index + 1] === "\r" && value[index + 2] === "\n") {
      index += 2;
      continue;
    }
    if (value[index + 1] === "\n") {
      index += 1;
      continue;
    }
    const hex = value.slice(index + 1, index + 3);
    // Real Gmail exports can contain a literal equals sign in a body that is
    // labelled quoted-printable. Preserve it and continue; the immutable raw
    // message remains authoritative, and one malformed body must not abort the
    // rest of an account export.
    if (!/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push("=".charCodeAt(0));
      continue;
    }
    bytes.push(Number.parseInt(hex, 16));
    index += 2;
  }
  return tolerantUtf8Decoder.decode(new Uint8Array(bytes));
}

function parseAddressList(value: string, role: Participant["role"] = "unknown"): Participant[] {
  return value.split(",").map((part) => decodeMimeHeader(part.trim())).filter(Boolean).map((part) => {
    const angle = part.match(/^(.*?)\s*<([^>]+)>$/);
    const id = (angle?.[2] ?? part).trim();
    const displayName = angle?.[1]?.replace(/^"|"$/g, "").trim() || undefined;
    return { id, ...(displayName ? { displayName } : {}), role };
  });
}

function formatAddresses(addresses: Participant[]): string {
  return addresses.map((address) => address.displayName ? `${address.displayName} <${address.id}>` : address.id).join(", ");
}

function decodeMimeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_match, charset: string, encoding: string, payload: string) => {
    try {
      if (encoding.toLowerCase() === "b") return tolerantUtf8Decoder.decode(Buffer.from(payload, "base64"));
      const bytes = payload.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_hex, value: string) => String.fromCharCode(Number.parseInt(value, 16)));
      return tolerantUtf8Decoder.decode(Buffer.from(bytes, "latin1"));
    } catch {
      return payload;
    }
  });
}

function parseYouTubeHistoryHtml(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const html = decodeUtf8(bytes, context.entry.path);
  const blocks = [...html.matchAll(/<div\b[^>]*class=["'][^"']*content-cell[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)].map((match) => match[1] ?? "");
  if (blocks.length === 0) throw new Error(`Malformed YouTube history HTML ${context.entry.path}: no content cells found.`);
  const isSearch = context.entry.path.toLowerCase().endsWith("search-history.html");
  const counts = new Map<string, number>();
  return blocks.flatMap((block, index) => {
    const text = stripHtml(block).replace(/\s+/g, " ").trim();
    const links = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
      url: decodeHtmlEntities(match[1] ?? ""),
      text: stripHtml(match[2] ?? "").replace(/\s+/g, " ").trim(),
    }));
    const selected = links.find((link) => isSearch ? /\/results\?/i.test(link.url) : /(?:youtube\.com\/watch|youtu\.be\/)/i.test(link.url));
    if (!selected) return [];
    const occurredAt = parseHumanDate(text);
    const videoId = isSearch ? undefined : youtubeVideoId(selected.url);
    const query = isSearch ? youtubeSearchQuery(selected.url) ?? selected.text : undefined;
    const title = isSearch ? query ?? selected.text : selected.text;
    const channel = !isSearch ? links.find((link) => link !== selected && !/\/watch\?|youtu\.be|youtube\.com/i.test(link.url))?.text : undefined;
    const identity = videoId ?? query ?? selected.url;
    const occurrence = (counts.get(identity) ?? 0) + 1;
    counts.set(identity, occurrence);
    const kind = isSearch ? "youtube-search" : "youtube-watch";
    const sourceRecord = { recordIndex: index + 1, html: block, text, links, ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}) };
    return [makeItem(context, {
      sourceItemId: itemId(context, kind, `${identity}#${occurrence}`),
      logicalId: `${context.entry.entryId}/${kind}/${identity}#${occurrence}`,
      itemType: isSearch ? "youtube-search" : "youtube-watch",
      title,
      contentText: isSearch ? `Searched for ${title}\n${selected.url}` : `Watched ${title}${channel ? `\n${channel}` : ""}\n${selected.url}`,
      participants: channel ? [{ id: channel, displayName: channel, role: "owner" }] : [],
      ...(occurredAt ? { occurredAt } : {}),
      flags: { youtube: true, ...(isSearch ? { searchHistory: true } : { watchHistory: true }) },
      projection: fullProjection(),
      sourceRecord,
      timelineSource: text,
      captureType: isSearch ? "google-takeout-youtube-search" : "google-takeout-youtube-watch",
      metadataExtra: {
        youtube: {
          ...(videoId ? { videoId } : {}),
          ...(query ? { query } : {}),
          ...(channel ? { channel } : {}),
          url: selected.url,
        },
      },
    })];
  });
}

function parseYouTubeCsv(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const text = decodeUtf8(bytes, context.entry.path);
  const rows = parseCsv(text, context.entry.path);
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  const base = context.entry.path.toLowerCase();
  const itemType = base.includes("subscription") ? "youtube-subscription" : base.includes("playlist") ? "youtube-playlist" : "youtube-channel";
  const counts = new Map<string, number>();
  return rows.slice(1).flatMap((values, index) => {
    if (values.every((value) => !value.trim())) return [];
    const record = recordFromCsv(headers, values);
    const title = firstValue(record, ["channel title", "channel name", "playlist title", "title", "name"]) ?? `${itemType} ${index + 1}`;
    const url = firstValue(record, ["channel url", "playlist url", "url"]);
    const stableBase = firstValue(record, ["channel id", "playlist id", "id", "channel url", "playlist url", "url"]) ?? title;
    const occurrence = (counts.get(stableBase) ?? 0) + 1;
    counts.set(stableBase, occurrence);
    const occurredAt = firstDateValue(record, ["subscription date", "subscribed at", "date", "timestamp"]);
    const sourceRecord = { rowNumber: index + 2, values: record, raw: values };
    return [makeItem(context, {
      sourceItemId: itemId(context, itemType, `${stableBase}#${occurrence}`),
      logicalId: `${context.entry.entryId}/${itemType}/${stableBase}#${occurrence}`,
      itemType,
      title,
      contentText: [title, firstValue(record, ["description", "channel description", "playlist description"]), url].filter(Boolean).join("\n"),
      participants: [],
      ...(occurredAt ? { occurredAt } : {}),
      flags: { youtube: true, csv: true },
      projection: fullProjection(),
      sourceRecord,
      ...(url ? { metadataExtra: { youtube: { url } } } : {}),
      ...(firstDateText(record) ? { timelineSource: firstDateText(record)! } : {}),
      captureType: `google-takeout-${itemType}`,
    })];
  });
}

function parseCalendar(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const text = decodeUtf8(bytes, context.entry.path);
  const lines = unfoldIcs(text);
  if (lines[0]?.toUpperCase() !== "BEGIN:VCALENDAR" || !lines.some((line) => line.toUpperCase() === "END:VCALENDAR")) {
    throw new Error(`Malformed iCalendar file ${context.entry.path}: missing VCALENDAR boundaries.`);
  }
  const events: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.toUpperCase() === "BEGIN:VEVENT") {
      if (current) throw new Error(`Malformed iCalendar file ${context.entry.path}: nested VEVENT.`);
      current = [line];
    } else if (line.toUpperCase() === "END:VEVENT") {
      if (!current) throw new Error(`Malformed iCalendar file ${context.entry.path}: stray END:VEVENT.`);
      current.push(line);
      events.push(current);
      current = undefined;
    } else if (current) current.push(line);
  }
  if (current) throw new Error(`Malformed iCalendar file ${context.entry.path}: unterminated VEVENT.`);
  const seen = new Map<string, number>();
  return events.map((event, index) => {
    const properties = parseIcsProperties(event, context.entry.path);
    const uid = firstProperty(properties, "uid") ?? `event-${index + 1}`;
    const occurrence = (seen.get(uid) ?? 0) + 1;
    seen.set(uid, occurrence);
    const start = parseIcsDate(properties.get("dtstart")?.[0]);
    const end = parseIcsDate(properties.get("dtend")?.[0]);
    const summary = firstProperty(properties, "summary") ?? "Calendar event";
    const description = firstProperty(properties, "description");
    const location = firstProperty(properties, "location");
    const url = firstProperty(properties, "url");
    const participants = parseIcsParticipants(properties);
    const sourceRecord = { eventIndex: index + 1, component: event.join("\r\n"), properties: Object.fromEntries([...properties.entries()].map(([key, values]) => [key, values.map((value) => value.value)])) };
    return makeItem(context, {
      sourceItemId: itemId(context, "calendar-event", `${uid}#${occurrence}`),
      logicalId: `${context.entry.entryId}/calendar-event/${uid}#${occurrence}`,
      itemType: "calendar-event",
      title: summary,
      contentText: [summary, description && readableHtml(description), location, url, participants.length ? `Attendees: ${participants.map((person) => person.displayName ?? person.id).join(", ")}` : undefined].filter(Boolean).join("\n"),
      participants,
      ...(start?.date ? { occurredAt: start.date } : {}),
      flags: { calendar: true, allDay: start?.allDay ?? false, ...(firstProperty(properties, "status") ? { status: firstProperty(properties, "status") } : {}) },
      projection: fullProjection(),
      sourceRecord,
      ...(start ? { timelineSource: start.raw } : {}),
      captureType: "google-takeout-calendar-event",
      metadataExtra: {
        calendar: {
          uid,
          ...(start ? { start: start.metadata } : {}),
          ...(end ? { end: end.metadata } : {}),
          ...(url ? { url } : {}),
        },
      },
    });
  });
}

type IcsProperty = { value: string; params: Record<string, string> };

function unfoldIcs(text: string): string[] {
  const physical = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (!logical.length) throw new Error("Malformed iCalendar continuation line.");
      logical[logical.length - 1] += line.slice(1);
    } else if (line && logical.length && !isIcsPropertyStart(line)) {
      // Some Google Takeout calendars omit the required leading space on a
      // folded description line. Keep it attached to the prior property.
      logical[logical.length - 1] += line;
    } else if (line) logical.push(line);
  }
  return logical;
}

function isIcsPropertyStart(line: string): boolean {
  const boundary = line.search(/[;:]/);
  return boundary > 0 && /^[A-Z0-9-]+$/i.test(line.slice(0, boundary));
}

function parseIcsProperties(event: string[], path: string): Map<string, IcsProperty[]> {
  const properties = new Map<string, IcsProperty[]>();
  for (const line of event.slice(1, -1)) {
    const colon = findIcsDelimiter(line, ":");
    if (colon <= 0) throw new Error(`Malformed iCalendar property in ${path}: ${line.slice(0, 60)}.`);
    const [name, ...paramParts] = splitIcsParameters(line.slice(0, colon));
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const equal = part.indexOf("=");
      if (equal <= 0) throw new Error(`Malformed iCalendar parameter in ${path}: ${part}.`);
      params[part.slice(0, equal).toUpperCase()] = part.slice(equal + 1).replace(/^"|"$/g, "");
    }
    const key = name!.toLowerCase();
    const values = properties.get(key) ?? [];
    values.push({ value: unescapeIcs(line.slice(colon + 1)), params });
    properties.set(key, values);
  }
  return properties;
}

function findIcsDelimiter(value: string, delimiter: ":" | ";"): number {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) return index;
  }
  return -1;
}

function splitIcsParameters(value: string): string[] {
  const parts: string[] = [];
  let remainder = value;
  while (remainder.length > 0) {
    const delimiter = findIcsDelimiter(remainder, ";");
    if (delimiter < 0) {
      parts.push(remainder);
      break;
    }
    parts.push(remainder.slice(0, delimiter));
    remainder = remainder.slice(delimiter + 1);
  }
  return parts;
}

function parseIcsDate(property: IcsProperty | undefined): { date?: Date; raw: string; allDay: boolean; metadata: Record<string, unknown> } | undefined {
  if (!property) return undefined;
  const raw = property.value;
  const allDay = property.params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(raw);
  const dateMatch = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/);
  if (!dateMatch) return { raw, allDay, metadata: { raw, ...(property.params.TZID ? { timezone: property.params.TZID } : {}) } };
  const [, year, month, day, hour = "00", minute = "00", second = "00", zone] = dateMatch;
  const timezone = property.params.TZID;
  const metadata = { raw, allDay, ...(zone ? { zone } : {}), ...(timezone ? { timezone } : {}) };
  // Floating times and dates have no instant without an external timezone.
  if (allDay || (!zone && !timezone)) return { raw, allDay, metadata };
  let milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60_000;
    milliseconds -= sign * offset;
  } else if (!zone && timezone) {
    try {
      milliseconds = zonedIcsMilliseconds(milliseconds, timezone);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // Unknown/custom VTIMEZONE identifiers retain their source wall time.
      return { raw, allDay, metadata: { ...metadata, unresolvedTimezone: true } };
    }
  }
  const date = new Date(milliseconds);
  return { date, raw, allDay, metadata: { ...metadata, iso: date.toISOString() } };
}

function zonedIcsMilliseconds(wallTime: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const offsetAt = (instant: number): number => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - instant;
  };
  const before = offsetAt(wallTime - 86_400_000);
  const after = offsetAt(wallTime + 86_400_000);
  const candidates = [...new Set([before, after])].map((offset) => wallTime - offset)
    .filter((instant) => instant + offsetAt(instant) === wallTime).sort((a, b) => a - b);
  // RFC 5545: first occurrence in a fold; pre-transition offset in a gap.
  return candidates[0] ?? wallTime - before;
}

function parseIcsParticipants(properties: Map<string, IcsProperty[]>): Participant[] {
  const participants: Participant[] = [];
  for (const property of [...(properties.get("organizer") ?? []), ...(properties.get("attendee") ?? [])]) {
    const id = property.value.replace(/^mailto:/i, "");
    const displayName = property.params.CN;
    participants.push({ id, ...(displayName ? { displayName } : {}), role: property === properties.get("organizer")?.[0] ? "owner" : "member" });
  }
  return participants;
}

function parseMapsJson(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const value = parseJson(bytes, context.entry.path);
  const records = extractJsonRecords(value);
  return records.map((record, index) => mapRecordToItem(record.value, context, index, record.key));
}

function parseSearchContributions(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const value = parseJson(bytes, context.entry.path);
  const records = extractJsonRecords(value);
  const counts = new Map<string, number>();
  return records.map((record, index) => {
    const query = firstValue(record.value, ["searchTerm", "searchQuery", "search query", "query", "term", "text"]) ?? record.key ?? `Search ${index + 1}`;
    const occurrence = (counts.get(query) ?? 0) + 1;
    counts.set(query, occurrence);
    const occurredAt = firstDateFromObject(record.value);
    return makeItem(context, {
      sourceItemId: itemId(context, "search-contribution", `${query}#${occurrence}`),
      logicalId: `${context.entry.entryId}/search-contribution/${query}#${occurrence}`,
      itemType: "search-contribution",
      title: `Search: ${query}`,
      contentText: `Searched for ${query}`,
      participants: [],
      ...(occurredAt ? { occurredAt } : {}),
      flags: { googleSearch: true, searchContribution: true },
      projection: fullProjection(),
      sourceRecord: { recordIndex: index + 1, key: record.key, value: record.value },
      ...(occurredAt ? { timelineSource: occurredAt.toISOString() } : {}),
      captureType: "google-takeout-search-contribution",
      metadataExtra: { search: { query } },
    });
  });
}

function parseMapsCsv(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const rows = parseCsv(decodeUtf8(bytes, context.entry.path), context.entry.path);
  if (!rows.length) return [];
  const headers = rows[0]!;
  return rows.slice(1).flatMap((values, index) => values.every((value) => !value.trim()) ? [] : [mapRecordToItem(recordFromCsv(headers, values), context, index, `row-${index + 2}`)]);
}

type JsonRecord = { value: Record<string, unknown>; key?: string };

function extractJsonRecords(value: unknown, key?: string): JsonRecord[] {
  if (Array.isArray(value)) return value.map((child, index) => ({ value: asRecord(child), key: key ? `${key}-${index}` : String(index) }));
  if (!isRecord(value)) return [{ value: { value }, ...(key ? { key } : {}) }];
  const arrays = Object.entries(value).filter(([, child]) => Array.isArray(child));
  if (arrays.length > 0) {
    return arrays.flatMap(([childKey, child]) =>
      (child as unknown[]).map((record, index) => ({ value: asRecord(record), key: `${childKey}-${index}` })),
    );
  }
  return [{ value, ...(key ? { key } : {}) }];
}

function mapRecordToItem(record: Record<string, unknown>, context: TakeoutEntryContext, index: number, recordKey?: string): SourceItemDraft {
  const original = record;
  record = { ...record, ...(record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? record.properties : {}) };
  const location = isRecord(record.location) ? record.location : {};
  record = { ...record, name: record.name ?? location.name, address: record.address ?? location.address };
  const kind = mapKind(context.entry.path, record, recordKey);
  const title = firstValue(record, ["title", "name", "placeName", "locationName", "label"]) ?? `${kind} ${index + 1}`;
  const place = firstValue(record, ["address", "formattedAddress", "location", "place"]);
  const review = firstValue(record, ["review", "review_text_published", "comment", "text", "note", "description"]);
  const question = firstValue(record, ["question", "questionText"]);
  const answer = firstValue(record, ["answer", "answerText"]);
  const url = firstValue(record, ["url", "googleMapsUrl", "google_maps_url", "placeUrl", "mapsUrl"]);
  const occurredAt = firstDateFromObject(record);
  const stableBase = firstValue(record, ["id", "placeId", "reviewId", "labelId", "questionId", "locationId"]) ?? recordKey ?? stableJson(record);
  const contentText = [title, place, review, question, answer, firstValue(record, ["category", "type"]), url].filter(Boolean).join("\n");
  return makeItem(context, {
    sourceItemId: itemId(context, kind, `${stableBase}#${index + 1}`),
    logicalId: `${context.entry.entryId}/${kind}/${stableBase}#${index + 1}`,
    itemType: kind,
    title,
    contentText: contentText + "\n" + JSON.stringify(original),
    participants: [],
    ...(occurredAt ? { occurredAt } : {}),
    flags: { googleMaps: true, ...(kind === "maps-review" ? { review: true } : {}), ...(kind === "maps-label" ? { label: true } : {}), ...(kind === "maps-question" ? { questionAndAnswer: true } : {}) },
    projection: fullProjection(),
    sourceRecord: { recordIndex: index + 1, key: recordKey, value: original },
    ...(occurredAt ? { timelineSource: occurredAt.toISOString() } : {}),
    captureType: `google-takeout-${kind}`,
    metadataExtra: { maps: { kind, ...(url ? { url } : {}), ...(place ? { place } : {}) } },
  });
}

function mapKind(path: string, record: Record<string, unknown>, key?: string): "maps-review" | "maps-label" | "maps-question" | "maps-history" | "search-contribution" {
  if (/search contributions/i.test(path)) return "search-contribution";
  const haystack = `${path} ${key ?? ""} ${Object.keys(record).join(" ")}`.toLowerCase();
  if (/review|rating|star/.test(haystack) || firstValue(record, ["comment", "review"])) return "maps-review";
  if (/question|answer|q&a|q and a/.test(haystack) || firstValue(record, ["question", "answer"])) return "maps-question";
  if (/label|saved place|your places|place label/.test(haystack) || firstValue(record, ["label", "address"])) return "maps-label";
  return "maps-history";
}

function makeItem(
  context: TakeoutEntryContext,
  input: {
    sourceItemId: string;
    logicalId: string;
    itemType: string;
    title: string;
    contentText: string;
    participants: Participant[];
    occurredAt?: Date;
    flags: Record<string, unknown>;
    projection: Record<string, unknown>;
    sourceRecord: Record<string, unknown>;
    timelineSource?: string;
    captureType: string;
    metadataExtra?: Record<string, unknown>;
  },
): SourceItemDraft {
  const provenance = archiveProvenance(context);
  const timeline = {
    ...(input.occurredAt ? { eventAt: input.occurredAt.toISOString() } : {}),
    ...(input.timelineSource ? { sourceEventValue: input.timelineSource } : {}),
    importedAt: context.importedAt.toISOString(),
  };
  const metadata = {
    provenance,
    timeline,
    projection: input.projection,
    fullReconciliation: true,
    ...(input.metadataExtra ?? {}),
  };
  const raw = {
    archive: provenance.archive,
    entry: provenance.entry,
    record: input.sourceRecord,
  };
  return {
    connectorId: "google-takeout-archive",
    sourceKind: "google-takeout",
    sourceAccountId: context.sourceAccountId,
    sourceItemId: input.sourceItemId,
    logicalId: input.logicalId,
    physicalId: context.entry.entryId,
    revisionId: sha256(stableJson({ input, raw: input.sourceRecord })),
    itemType: input.itemType,
    title: input.title,
    contentText: input.contentText,
    participants: input.participants,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    receivedAt: context.importedAt,
    isDeleted: false,
    flags: input.flags,
    metadata,
    attachments: [],
    rawCapture: {
      sourceRecordId: input.sourceItemId,
      captureType: input.captureType,
      schemaVersion: "google-takeout-v1",
      raw,
      metadata: { provenance, projection: input.projection },
    },
  };
}

function archiveProvenance(context: TakeoutEntryContext): {
  archive: { sha256: string; byteLength: number; source: string; encryptedArchiveReady: boolean };
  entry: ReturnType<typeof entryProvenance>;
} {
  return {
    archive: {
      sha256: context.archiveSha256,
      byteLength: context.archiveBytes,
      source: "google-takeout-zip",
      encryptedArchiveReady: true,
    },
    entry: entryProvenance(context),
  };
}

function entryProvenance(context: TakeoutEntryContext): {
  id: string;
  path: string;
  sha256: string;
  compressedSha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMethod: number;
  crc32: number;
  locator: string;
} {
  return {
    id: context.entry.entryId,
    path: context.entry.path,
    sha256: context.entrySha256,
    compressedSha256: context.entry.compressedSha256,
    compressedBytes: context.entry.compressedSize,
    uncompressedBytes: context.entry.uncompressedSize,
    compressionMethod: context.entry.compressionMethod,
    crc32: context.entry.crc32,
    locator: `google-takeout://${context.archiveSha256}/entry/${encodeURIComponent(context.entry.path)}`,
  };
}

function fullProjection(): Record<string, unknown> {
  return { mode: "full", searchable: true, defaultSearchable: true, semanticSearchable: true };
}

function itemId(context: TakeoutEntryContext, kind: string, stableKey: string): string {
  return `${context.entry.entryId}/${kind}/${encodeURIComponent(stableKey)}`;
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  const text = decodeUtf8(bytes, path).replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed JSON in ${path}: ${errorMessage(error)}`);
  }
}

export function parseCsv(text: string, path: string, backslashQuotes = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (backslashQuotes && character === "\\" && text[index + 1] === '"') {
        // LinkedIn comments use backslash-escaped quotes alongside doubled CSV quotes.
        field += '"';
        index += 1;
      } else if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else field += character;
      continue;
    }
    if (afterQuote) {
      if (character === ",") {
        row.push(field);
        field = "";
        afterQuote = false;
      } else if (character === "\r" || character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        afterQuote = false;
        if (character === "\r" && text[index + 1] === "\n") index += 1;
      } else if (character.trim()) {
        throw new Error(`Malformed CSV ${path}: characters after a quoted field.`);
      }
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error(`Malformed CSV ${path}: unterminated quoted field.`);
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function recordFromCsv(headers: string[], values: string[]): Record<string, unknown> {
  return Object.fromEntries(headers.map((header, index) => [header.trim().toLowerCase(), values[index] ?? ""]));
}

function firstValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  const normalized = keys.map((key) => key.toLowerCase());
  for (const [key, value] of Object.entries(record)) {
    if (!normalized.includes(key.toLowerCase())) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function firstDateValue(record: Record<string, unknown>, keys: string[]): Date | undefined {
  const value = firstValue(record, keys);
  return value ? parseFlexibleDate(value) : firstDateFromObject(record);
}

function firstDateText(record: Record<string, unknown>): string | undefined {
  const value = firstValue(record, ["subscription date", "subscribed at", "date", "timestamp"]);
  return value;
}

function firstDateFromObject(record: Record<string, unknown>): Date | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (!/(date|time|timestamp|created|updated|visited|occurred)|^published$/i.test(key)) continue;
    const parsed = typeof value === "number" ? parseNumericDate(value) : typeof value === "string" ? parseFlexibleDate(value) : undefined;
    if (parsed) return parsed;
  }
  return undefined;
}

function parseFlexibleDate(value: string): Date | undefined {
  const numeric = Number(value);
  if (value.trim() && Number.isFinite(numeric) && /^\d{9,16}$/.test(value.trim())) return parseNumericDate(numeric);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function parseNumericDate(value: number): Date | undefined {
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function parseHumanDate(text: string): Date | undefined {
  const candidates = text.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}[^<\n]*/i) ??
    text.match(/[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}(?:,?\s+[^<\n]+)?/i) ??
    text.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/);
  if (!candidates) return undefined;
  const timestamp = Date.parse(candidates[0]!);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function youtubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1) || undefined;
    return parsed.searchParams.get("v") ?? undefined;
  } catch {
    return undefined;
  }
}

function youtubeSearchQuery(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("search_query") ?? undefined;
  } catch {
    return undefined;
  }
}

export function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n").replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " "));
}
export function readableHtml(value:string) {
  return /<(?:html|body|div|table|p|span|a|br|b|strong|ul|li|h[1-6])\b[^>]*>/i.test(value) ? stripHtml(value).replace(/[ \t]+/g," ").replace(/\n\s*\n\s*\n/g,"\n\n").trim() : value;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.toLowerCase().startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? _match;
  });
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`Entry ${path} is not valid UTF-8.`);
  }
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.split("/").some((part) => part === segment);
}

function isMapsPath(path: string): boolean {
  return path.split("/").some((part) => part === "maps" || part === "maps (your places)");
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstHeader(headers: Record<string, string[]>, key: string): string | undefined {
  return headers[key]?.[0];
}

function firstProperty(properties: Map<string, IcsProperty[]>, key: string): string | undefined {
  return properties.get(key)?.[0]?.value;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value instanceof Date ? value.toISOString() : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
