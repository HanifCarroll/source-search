// Extracted from LifeOS Messages reader; provenance is recorded in REUSE.md.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFile,lstat,mkdtemp,rm } from "node:fs/promises";
import { homedir,tmpdir } from "node:os";
import { basename,join,resolve } from "node:path";
export async function createSnapshot(sourcePath: string): Promise<Snapshot> {
  const directory = await mkdtemp(join(tmpdir(), MESSAGES_SNAPSHOT_PREFIX));
  const snapshotPath = join(directory, basename(sourcePath));
  let database: Database | undefined;
  let lastError: unknown;

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await inspectSourceFiles(sourcePath);
      await rm(`${snapshotPath}-wal`, { force: true });
      await rm(`${snapshotPath}-shm`, { force: true });
      await copyFile(sourcePath, snapshotPath);
      if (before.wal) await copyOptionalFile(`${sourcePath}-wal`, `${snapshotPath}-wal`);
      if (before.shm) await copyOptionalFile(`${sourcePath}-shm`, `${snapshotPath}-shm`);
      const after = await inspectSourceFiles(sourcePath);
      if (!sourceFileSetsEqual(before, after)) {
        lastError = new MessagesSnapshotError(
          "INCONSISTENT_SNAPSHOT",
          "Messages database or WAL/SHM sidecars changed while the temporary snapshot was copied.",
        );
        continue;
      }

      try {
        const opened = openCopiedDatabase(snapshotPath);
        database = opened.database;
        const sourceModifiedAt = Number.isFinite(before.database.mtimeMs)
          ? new Date(before.database.mtimeMs).toISOString()
          : null;
        return {
          database,
          sourcePath,
          sourceFiles: before,
          sourceDatabaseModifiedAt: sourceModifiedAt,
          journalMode: opened.journalMode,
          quickCheck: opened.quickCheck,
          close: async () => {
            try {
              try {
                database?.run("ROLLBACK");
              } catch {
                // The read transaction may already have ended.
              }
            } finally {
              try {
                database?.close();
              } finally {
                await rm(directory, { recursive: true, force: true });
              }
            }
          },
        };
      } catch (error) {
        lastError = error;
        try {
          database?.close();
        } catch {
          // Cleanup below is sufficient.
        }
        database = undefined;
        if (error instanceof MessagesSnapshotError && error.code === "SNAPSHOT_QUICK_CHECK_FAILED") break;
      }
    }
    throw lastError ?? new MessagesSnapshotError(
      "INCONSISTENT_SNAPSHOT",
      "Could not create a stable Messages database snapshot after three attempts.",
    );
  } finally {
    if (!database) await rm(directory, { recursive: true, force: true });
  }
}

type Snapshot = {
  database: Database;
  sourcePath: string;
  sourceFiles: SourceFileSet;
  sourceDatabaseModifiedAt: string | null;
  journalMode: string | null;
  quickCheck: string | null;
  close: () => Promise<void>;
};

type SourceFileSet = {
  database: FileFingerprint;
  wal: FileFingerprint | null;
  shm: FileFingerprint | null;
};

type FileFingerprint = {
  exists: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
};

export const MESSAGES_SNAPSHOT_PREFIX = "source-search-messages-" as const;

async function inspectSourceFiles(path: string): Promise<SourceFileSet> {
  const [database, wal, shm] = await Promise.all([
    regularFileFingerprint(path, true),
    regularFileFingerprint(`${path}-wal`, false),
    regularFileFingerprint(`${path}-shm`, false),
  ]);
  if (!database) throw new MessagesSnapshotError("SOURCE_DATABASE_MISSING", `Messages database was not found: ${path}`);
  return { database, wal, shm };
}

async function regularFileFingerprint(path: string, required: boolean): Promise<FileFingerprint | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    if (!required && code === "ENOENT") return null;
    if (code === "ENOENT") {
      throw new MessagesSnapshotError("SOURCE_DATABASE_MISSING", `Messages database was not found: ${path}`);
    }
    throw new MessagesSnapshotError(
      "SOURCE_DATABASE_UNAVAILABLE",
      `Messages database could not be inspected: ${path}: ${errorMessage(error)}`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new MessagesSnapshotError(
      "SOURCE_SYMLINK_REJECTED",
      `Messages source file is a symbolic link and was not followed: ${path}`,
    );
  }
  if (!info.isFile()) {
    throw new MessagesSnapshotError(
      "SOURCE_NOT_REGULAR_FILE",
      `Messages source file is not a regular file: ${path}`,
    );
  }
  return {
    exists: true,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: Number(info.ino),
    dev: Number(info.dev),
  };
}

class MessagesSnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MessagesSnapshotError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyOptionalFile(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    if (code === "ENOENT") {
      throw new MessagesSnapshotError(
        "INCONSISTENT_SNAPSHOT",
        `Messages sidecar disappeared while copying: ${source}`,
      );
    }
    throw error;
  }
}

function sourceFileSetsEqual(left: SourceFileSet, right: SourceFileSet): boolean {
  return (
    fileFingerprintEqual(left.database, right.database) &&
    fileFingerprintEqual(left.wal, right.wal) &&
    fileFingerprintEqual(left.shm, right.shm)
  );
}

function fileFingerprintEqual(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.exists === right.exists &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

function openCopiedDatabase(path: string): {
  database: Database;
  journalMode: string | null;
  quickCheck: string | null;
} {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true, safeIntegers: true });
    database.run("PRAGMA query_only = ON");
    database.run("PRAGMA busy_timeout = 0");
    const queryOnly = numberValue(firstPragmaValue(database, "query_only"));
    if (queryOnly !== 1) {
      throw new MessagesSnapshotError(
        "QUERY_ONLY_NOT_CONFIRMED",
        "Copied Messages snapshot did not confirm PRAGMA query_only=1.",
      );
    }
    const journalMode = stringValue(firstPragmaValue(database, "journal_mode"));
    database.run("BEGIN DEFERRED");
    const quickCheck = stringValue(firstPragmaValue(database, "quick_check"));
    if (quickCheck !== "ok") {
      throw new MessagesSnapshotError(
        "SNAPSHOT_QUICK_CHECK_FAILED",
        `Copied Messages snapshot PRAGMA quick_check returned ${quickCheck ?? "unknown"}.`,
      );
    }
    return { database, journalMode, quickCheck };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The connection is already unusable.
    }
    throw error;
  }
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function firstPragmaValue(database: Database, pragma: string): unknown {
  return scalar(database.query(`PRAGMA ${pragma}`).get() as SqliteRow | null);
}

function scalar(row: SqliteRow | null | undefined): unknown {
  if (!row) return null;
  return Object.values(row)[0] ?? null;
}

type SqliteRow = Record<string, unknown>;

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return null;
  const result = String(value);
  return result.length > 0 ? result : null;
}

async function sourceModifiedAt(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return info.mtime.toISOString();
  } catch {
    return null;
  }
}

export function decodeAttributedBody(value: unknown): AttributedBodyDecodeResult {
  const bytes = bytesValue(value);
  if (!bytes || bytes.byteLength === 0) {
    return {
      status: "undecodable",
      warning: "attributedBody was present but was empty or not a binary SQLite value.",
    };
  }
  if (bytes.byteLength > MAX_ATTRIBUTED_BODY_BYTES) {
    return {
      status: "undecodable",
      warning: `attributedBody was ${bytes.byteLength} bytes, above the safe decode limit.`,
    };
  }
  try {
    const text = decodeMessageString(bytes);
    return { status: "decoded", text, encoding: "utf8-run" };
  } catch {
    return { status: "undecodable", warning: "Unsupported or incomplete attributedBody; no text was guessed." };
  }
}

export type AttributedBodyDecodeResult = {
  status: "decoded" | "undecodable";
  text?: string;
  warning?: string;
  encoding?: "utf8-run";
};
function bytesValue(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
}
const MAX_ATTRIBUTED_BODY_BYTES = 16 * 1024 * 1024;

// The supported NSAttributedString prefix contains its NSString before any attributes.
// Length tags follow the typedstream format documented by python-typedstream (REUSE.md).
function decodeMessageString(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  const byte = () => { if (offset >= bytes.length) throw Error("Truncated stream"); return bytes[offset++]!; };
  const take = (length: number) => { if (length < 0 || offset + length > bytes.length) throw Error("Invalid length"); const data = bytes.subarray(offset, offset + length); offset += length; return data; };
  const signature = Buffer.from(bytes.subarray(2, 13)).toString("ascii");
  if (bytes[0] !== 4 || bytes[1] !== 11 || !["streamtyped", "typedstream"].includes(signature)) {
    const text = utf8.decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /^(?:bplist00|streamtyped|__kIM)/.test(text)) throw Error("Unsupported archive");
    return text;
  }
  offset = 13;
  const littleEndian = signature === "streamtyped";
  const integer = () => {
    const head = byte();
    if (head === 0x81 || head === 0x82) {
      const data = take(head === 0x81 ? 2 : 4), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return head === 0x81 ? view.getUint16(0, littleEndian) : view.getUint32(0, littleEndian);
    }
    if (head >= 0x80 && head <= 0x91) throw Error("Unexpected tag");
    return head;
  };
  const strings: string[] = [];
  const shared = () => {
    const head = byte();
    if (head === 0x84) { const text = utf8.decode(take(integer())); strings.push(text); return text; }
    const index = head - 0x92;
    if (index < 0 || index >= strings.length) throw Error("Invalid shared string");
    return strings[index]!;
  };
  const classes = () => {
    const names: string[] = [];
    let head = byte();
    while (head === 0x84) { names.push(shared()); integer(); head = byte(); if (names.length > 8) throw Error("Too many classes"); }
    if (head !== 0x85 && head < 0x92) throw Error("Invalid superclass");
    return names;
  };
  integer();
  if (shared() !== "@" || byte() !== 0x84 || !classes().includes("NSAttributedString")) throw Error("Unsupported root");
  if (shared() !== "@" || byte() !== 0x84 || !classes().includes("NSString")) throw Error("Missing message string");
  if (shared() !== "+") throw Error("Unsupported string encoding");
  const text = utf8.decode(take(integer()));
  if (byte() !== 0x86) throw Error("Incomplete string object");
  return text;
}

export function sanitizeUnicodeText(value: string): string {
  let sanitized = "";
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
    const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (changed) sanitized += value.slice(index, index + 2);
        index += 1;
        continue;
      }
      if (!changed) {
        sanitized = value.slice(0, index);
        changed = true;
      }
      sanitized += "\uFFFD";
      continue;
    }

    if (isLowSurrogate) {
      if (!changed) {
        sanitized = value.slice(0, index);
        changed = true;
      }
      sanitized += "\uFFFD";
      continue;
    }

    if (changed) sanitized += value[index]!;
  }

  return changed ? sanitized : value;
}

export function messagesTimestampToIso(value: unknown): string | undefined {
  return appleDateToDate(value)?.toISOString();
}

function appleDateToDate(value: unknown): Date | undefined {
  const raw = integerString(value);
  if (!raw) return undefined;
  let timestamp: bigint;
  try {
    timestamp = BigInt(raw);
  } catch {
    return undefined;
  }
  if (timestamp === 0n) return undefined;
  const absolute = timestamp < 0n ? -timestamp : timestamp;
  let milliseconds: number;
  if (absolute >= 100_000_000_000_000_000n) {
    milliseconds = Number(timestamp / 1_000_000n) + APPLE_EPOCH_MILLISECONDS;
  } else if (absolute >= 100_000_000_000_000n) {
    milliseconds = Number(timestamp / 1_000n) + APPLE_EPOCH_MILLISECONDS;
  } else if (absolute >= 100_000_000_000n) {
    milliseconds = Number(timestamp) + APPLE_EPOCH_MILLISECONDS;
  } else {
    milliseconds = Number(timestamp + APPLE_EPOCH_SECONDS) * 1_000;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function integerString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value).toString();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed).toString() : null;
}

const APPLE_EPOCH_MILLISECONDS = 978_307_200_000;

const APPLE_EPOCH_SECONDS = 978_307_200n;
