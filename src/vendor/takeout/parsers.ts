import {parseCalendarComponent,calendarDate} from "../../formats/calendar";
import {parseMimeMessage} from "../../formats/mime";
import {stripHtml,readableHtml} from "../../formats/html";
import { createHash } from "node:crypto";
import {parseDocument, DomUtils} from 'htmlparser2';
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

export async function parseTakeoutEntry(
  classified: ClassifiedTakeoutEntry,
  bytes: Uint8Array,
  context: TakeoutEntryContext,
  mailboxMessageIndex?: number,
): Promise<ParsedTakeoutEntry> {
  switch (classified.kind) {
    case "mailbox":
      return { items: await parseMailbox(bytes, context, mailboxMessageIndex) };
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

async function parseMailbox(bytes: Uint8Array, context: TakeoutEntryContext, only?:number): Promise<SourceItemDraft[]> {
  if(only!==undefined && (!Number.isSafeInteger(only) || only<1 || only>200_000))throw Error("Invalid original mailbox message index");
  // Latin-1 gives a one-to-one byte mapping for MBOX boundaries; MIME decodes each part's declared charset.
  const text = Buffer.from(bytes).toString("latin1");
  const starts = [...text.matchAll(/^From [^\r\n]*(?:\r\n|\n|\r|$)/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) throw new Error(`Malformed MBOX ${context.entry.path}: no message separators found.`);
  const items: SourceItemDraft[] = [];
  const identities = new Map<string, number>();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? text.length;
    const rawBytes = Buffer.from(text.slice(start,end),"latin1");
    const rawMessage = rawBytes.toString("utf8");
    const byteMessage = rawBytes.toString("latin1");
    const separatorEnd = byteMessage.search(/\r?\n|\r/);
    if (separatorEnd < 0) throw new Error(`Malformed MBOX message ${index + 1} in ${context.entry.path}.`);
    const separator = Buffer.from(byteMessage.slice(0, separatorEnd),"latin1").toString("utf8");
    const message = byteMessage.slice(separatorEnd + (byteMessage[separatorEnd] === "\r" && byteMessage[separatorEnd + 1] === "\n" ? 2 : 1));
    // Earlier headers determine duplicate Message-ID occurrences; MIME bodies need parsing only for the selected original.
    if(only!==undefined && index+1!==only){
      if(index+1>only)break;
      const boundary=message.search(/\r?\n\r?\n|\r\n?\r/);if(boundary<0)throw Error("Malformed mailbox message before selected record");
      const id=firstHeader(parseHeaders(message.slice(0,boundary),context.entry.path),"message-id")?.trim() || `sha256:${sha256(rawMessage)}`;
      identities.set(id,(identities.get(id) || 0)+1);continue;
    }
    if(message.search(/\r?\n\r?\n|\r\n?\r/)<0)throw Error(`Malformed MBOX message ${index+1}: missing header/body boundary`);
    const parsed = await parseMimeMessage(Buffer.from(message,"latin1"));
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

function parseYouTubeHistoryHtml(bytes: Uint8Array, context: TakeoutEntryContext): SourceItemDraft[] {
  const html = decodeUtf8(bytes, context.entry.path);
  const document = parseDocument(html, {withStartIndices:true, withEndIndices:true});
  const cells = DomUtils.findAll(node => node.name === 'div' &&
    (node.attribs.class || '').split(/\s+/).includes('content-cell'), document.children);
  // Source slices preserve original HTML and existing revision hashes. DOM
  // serialization would rewrite entities/attributes in otherwise unchanged exports.
  const blocks = cells.map(cell => ({cell, html:cell.children.length
    ? html.slice(cell.children[0]!.startIndex!, cell.children.at(-1)!.endIndex! + 1) : ''}));
  if (blocks.length === 0) throw new Error(`Malformed YouTube history HTML ${context.entry.path}: no content cells found.`);
  const isSearch = context.entry.path.toLowerCase().endsWith("search-history.html");
  const counts = new Map<string, number>();
  return blocks.flatMap(({cell, html:block}, index) => {
    const text = stripHtml(block).replace(/\s+/g, " ").trim();
    const links = DomUtils.findAll(node => node.name === 'a' && node.attribs.href !== undefined, cell.children).map(link => ({
      url: link.attribs.href!,
      text: stripHtml(link.children.length ? html.slice(link.children[0]!.startIndex!, link.children.at(-1)!.endIndex! + 1) : '').replace(/\s+/g, ' ').trim(),
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
  const calendar=parseCalendarComponent(text),events=calendar.getAllSubcomponents("vevent");
  const seen = new Map<string, number>();
  return events.map((event, index) => {
    const properties=new Map<string,IcsProperty[]>();
    for(const property of event.getAllProperties()){
      const values=properties.get(property.name)||[];
      const params=Object.fromEntries(Object.entries(property.toJSON()[1]).map(([key,value])=>[key.toUpperCase(),String(value)]));
      values.push({value:String(property.getFirstValue()??""),params});properties.set(property.name,values);
    }
    const uid = firstProperty(properties, "uid") ?? `event-${index + 1}`;
    const occurrence = (seen.get(uid) ?? 0) + 1;
    seen.set(uid, occurrence);
    const start = calendarDate(event.getFirstProperty("dtstart"));
    const end = calendarDate(event.getFirstProperty("dtend"));
    const summary = firstProperty(properties, "summary") ?? "Calendar event";
    const description = firstProperty(properties, "description");
    const location = firstProperty(properties, "location");
    const url = firstProperty(properties, "url");
    const participants = parseIcsParticipants(properties);
    const sourceRecord = { eventIndex: index + 1, component: event.toString(), properties: Object.fromEntries([...properties.entries()].map(([key, values]) => [key, values.map((value) => value.value)])) };
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

function decodeHtmlEntities(value: string): string {
  return stripHtml(value.replaceAll("<","&lt;").replaceAll(">","&gt;"));
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
