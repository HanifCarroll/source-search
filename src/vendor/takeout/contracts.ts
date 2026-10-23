import type { ArchivedRawCaptureDraft, SourceItemDraft } from "../source-types";
import type { SafeZipEntry } from "./zip";
export type ArchiveOnlyTakeoutCapture = ArchivedRawCaptureDraft;

export type TakeoutEntryContext = {
  archiveSha256: string;
  archiveBytes: number;
  importedAt: Date;
  sourceAccountId: string;
  entry: SafeZipEntry;
  entrySha256: string;
};

export type ParsedTakeoutEntry = {
  items: SourceItemDraft[];
  incomplete?: { entryPath: string; reason: "malformed-json" };
  archiveOnly?: ArchiveOnlyTakeoutCapture;
  warning?: string;
};

export type ParsedTakeoutEntryKind =
  | "mailbox"
  | "settings"
  | "youtube-html"
  | "youtube-csv"
  | "calendar"
  | "maps-json"
  | "maps-csv"
  | "search-contributions"
  | "ignored-out-of-scope"
  | "ignored-unsupported";

export type ClassifiedTakeoutEntry = {
  entry: SafeZipEntry;
  kind: ParsedTakeoutEntryKind;
};
