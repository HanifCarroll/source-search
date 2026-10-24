// Snapshot logic adapted from LifeOS.
import { Database } from "bun:sqlite";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fail } from "../domain/identity";

export async function createSnapshot(sourcePath: string): Promise<Snapshot> {
  const directory = await mkdtemp(join(tmpdir(), SNAPSHOT_PREFIX));
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
        lastError = new SnapshotError(
          "INCONSISTENT_SNAPSHOT",
          "Source database or WAL/SHM sidecars changed while the temporary snapshot was copied.",
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
        if (error instanceof SnapshotError && error.code === "SNAPSHOT_QUICK_CHECK_FAILED") break;
      }
    }
    throw lastError ?? new SnapshotError(
      "INCONSISTENT_SNAPSHOT",
      "Could not create a stable Source database snapshot after three attempts.",
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

const SNAPSHOT_PREFIX = "source-search-sqlite-" as const;

async function inspectSourceFiles(path: string): Promise<SourceFileSet> {
  const [database, wal, shm] = await Promise.all([
    regularFileFingerprint(path, true),
    regularFileFingerprint(`${path}-wal`, false),
    regularFileFingerprint(`${path}-shm`, false),
  ]);
  if (!database) throw new SnapshotError("SOURCE_DATABASE_MISSING", `Source database was not found: ${path}`);
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
      throw new SnapshotError("SOURCE_DATABASE_MISSING", `Source database was not found: ${path}`);
    }
    throw new SnapshotError(
      "SOURCE_DATABASE_UNAVAILABLE",
      `Source database could not be inspected: ${path}: ${errorMessage(error)}`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new SnapshotError(
      "SOURCE_SYMLINK_REJECTED",
      `Source file is a symbolic link and was not followed: ${path}`,
    );
  }
  if (!info.isFile()) {
    throw new SnapshotError(
      "SOURCE_NOT_REGULAR_FILE",
      `Source file is not a regular file: ${path}`,
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

class SnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SnapshotError";
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
      throw new SnapshotError(
        "INCONSISTENT_SNAPSHOT",
        `Database sidecar disappeared while copying: ${source}`,
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
    // This is the disposable copy, never the source. SQLite must be able to
    // recreate absent WAL/SHM sidecars for a cleanly closed WAL database.
    // query_only below still rejects all application writes to the snapshot.
    database = new Database(path, { readwrite: true, strict: true, safeIntegers: true });
    database.run("PRAGMA query_only = ON");
    database.run("PRAGMA busy_timeout = 0");
    const queryOnly = numberValue(firstPragmaValue(database, "query_only"));
    if (queryOnly !== 1) {
      throw new SnapshotError(
        "QUERY_ONLY_NOT_CONFIRMED",
        "Copied database snapshot did not confirm PRAGMA query_only=1.",
      );
    }
    const journalMode = stringValue(firstPragmaValue(database, "journal_mode"));
    database.run("BEGIN DEFERRED");
    const quickCheck = stringValue(firstPragmaValue(database, "quick_check"));
    if (quickCheck !== "ok") {
      throw new SnapshotError(
        "SNAPSHOT_QUICK_CHECK_FAILED",
        `Copied database snapshot PRAGMA quick_check returned ${quickCheck ?? "unknown"}.`,
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

export function requireColumns(db: Database, table: string, names: string[]) {
  const columns = new Set((db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(r => r.name));
  if (names.some(n => !columns.has(n))) fail("UNSUPPORTED_SCHEMA", `Source table ${table} lacks required content columns`);
  return columns;
}
