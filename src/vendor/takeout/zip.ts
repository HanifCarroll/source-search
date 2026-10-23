import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const STRONG_ENCRYPTION_FLAG = 0x0040;

export const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 100_000;
export const DEFAULT_MAX_COMPRESSION_RATIO = 500;

export type ZipSafetyLimits = {
  maxArchiveBytes?: number;
  maxEntryBytes?: number;
  maxTotalUncompressedBytes?: number;
  maxEntries?: number;
  maxCompressionRatio?: number;
};

export type SafeZipEntry = {
  path: string;
  entryId: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: 0 | 8;
  crc32: number;
  flags: number;
  externalAttributes: number;
  localHeaderOffset: number;
  compressedSha256: string;
  sha256?: string;
};

export type SafeZipArchive = {
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly entries: readonly SafeZipEntry[];
  readonly totalDeclaredUncompressedBytes: number;
  readonly limits: Required<ZipSafetyLimits>;
  readEntry(entry: SafeZipEntry): Promise<Uint8Array>;
};

type CentralDirectoryLocation = {
  offset: number;
  size: number;
  entries: number;
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function loadSafeZipArchive(
  input: string | Uint8Array,
  limits: ZipSafetyLimits = {},
): Promise<SafeZipArchive> {
  const resolvedLimits = resolveLimits(limits);
  const bytes = await readInputBytes(input, resolvedLimits.maxArchiveBytes);
  return parseSafeZipArchive(bytes, resolvedLimits);
}

export function parseSafeZipArchive(
  input: Uint8Array,
  limits: ZipSafetyLimits = {},
): SafeZipArchive {
  const resolvedLimits = resolveLimits(limits);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > resolvedLimits.maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${resolvedLimits.maxArchiveBytes} byte safety limit.`);
  }
  if (bytes.byteLength === 0) throw new Error("ZIP archive is empty.");

  const archiveSha256 = sha256(bytes);
  const centralDirectory = findCentralDirectory(bytes);
  const entries = parseCentralDirectory(bytes, centralDirectory, resolvedLimits);
  const totalDeclaredUncompressedBytes = entries.reduce(
    (total, entry) => total + entry.uncompressedSize,
    0,
  );
  if (totalDeclaredUncompressedBytes > resolvedLimits.maxTotalUncompressedBytes) {
    throw new Error(
      `ZIP archive declares ${totalDeclaredUncompressedBytes} uncompressed bytes, above the ${resolvedLimits.maxTotalUncompressedBytes} byte safety limit.`,
    );
  }

  return {
    archiveBytes: bytes.byteLength,
    archiveSha256,
    entries,
    totalDeclaredUncompressedBytes,
    limits: resolvedLimits,
    async readEntry(entry) {
      const known = entries.find((candidate) => candidate.entryId === entry.entryId);
      if (!known) throw new Error(`Unknown ZIP entry: ${entry.path}`);
      if (known.isDirectory) return new Uint8Array();
      const data = await readEntryBytes(bytes, known, resolvedLimits);
      known.sha256 = sha256(data);
      return data;
    },
  };
}

function resolveLimits(limits: ZipSafetyLimits): Required<ZipSafetyLimits> {
  const resolved = {
    maxArchiveBytes: limits.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    maxEntryBytes: limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    maxTotalUncompressedBytes:
      limits.maxTotalUncompressedBytes ?? DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxCompressionRatio: limits.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  return resolved;
}

async function readInputBytes(input: string | Uint8Array, maxArchiveBytes: number): Promise<Uint8Array> {
  if (typeof input !== "string") return new Uint8Array(input);
  const metadata = await lstat(input);
  if (metadata.isSymbolicLink()) throw new Error("ZIP archive input must not be a symbolic link.");
  if (!metadata.isFile()) throw new Error("ZIP archive input must be a regular file.");
  if (metadata.size > maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${maxArchiveBytes} byte safety limit.`);
  }
  const bytes = await readFile(input);
  if (bytes.byteLength !== metadata.size) {
    throw new Error("ZIP archive changed while it was being read.");
  }
  return new Uint8Array(bytes);
}

function findCentralDirectory(bytes: Uint8Array): CentralDirectoryLocation {
  const lowerBound = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (u32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = u16(bytes, offset + 20);
    if (offset + 22 + commentLength !== bytes.length) continue;

    const diskNumber = u16(bytes, offset + 4);
    const centralDirectoryDisk = u16(bytes, offset + 6);
    const entriesOnDisk = u16(bytes, offset + 8);
    const entries = u16(bytes, offset + 10);
    const size = u32(bytes, offset + 12);
    const centralOffset = u32(bytes, offset + 16);
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entries) {
      throw new Error("Multi-disk ZIP archives are not supported.");
    }

    const needsZip64 =
      entries === 0xffff || entriesOnDisk === 0xffff || size === 0xffffffff || centralOffset === 0xffffffff;
    if (!needsZip64) {
      assertRange(bytes, centralOffset, size, "central directory");
      return { offset: centralOffset, size, entries };
    }
    return readZip64CentralDirectory(bytes, offset);
  }
  throw new Error("ZIP end-of-central-directory record was not found.");
}

function readZip64CentralDirectory(bytes: Uint8Array, eocdOffset: number): CentralDirectoryLocation {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0 || u32(bytes, locatorOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
    throw new Error("ZIP uses ZIP64 markers but has no ZIP64 end-of-central-directory locator.");
  }
  if (u32(bytes, locatorOffset + 4) !== 0) throw new Error("Multi-disk ZIP64 archives are not supported.");
  const zip64Offset = safeNumber(u64(bytes, locatorOffset + 8), "ZIP64 end-of-central-directory offset");
  assertRange(bytes, zip64Offset, 56, "ZIP64 end-of-central-directory");
  if (u32(bytes, zip64Offset) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw new Error("ZIP64 end-of-central-directory record is malformed.");
  }
  const recordSize = safeNumber(u64(bytes, zip64Offset + 4), "ZIP64 record size");
  assertRange(bytes, zip64Offset, 12 + recordSize, "ZIP64 end-of-central-directory record");
  const diskNumber = u32(bytes, zip64Offset + 16);
  const centralDirectoryDisk = u32(bytes, zip64Offset + 20);
  const entriesOnDisk = safeNumber(u64(bytes, zip64Offset + 24), "ZIP64 entries on disk");
  const entries = safeNumber(u64(bytes, zip64Offset + 32), "ZIP64 entry count");
  const size = safeNumber(u64(bytes, zip64Offset + 40), "ZIP64 central-directory size");
  const offset = safeNumber(u64(bytes, zip64Offset + 48), "ZIP64 central-directory offset");
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entries) {
    throw new Error("Multi-disk ZIP64 archives are not supported.");
  }
  assertRange(bytes, offset, size, "central directory");
  return { offset, size, entries };
}

function parseCentralDirectory(
  bytes: Uint8Array,
  location: CentralDirectoryLocation,
  limits: Required<ZipSafetyLimits>,
): SafeZipEntry[] {
  if (location.entries > limits.maxEntries) {
    throw new Error(`ZIP archive contains ${location.entries} entries, above the ${limits.maxEntries} entry safety limit.`);
  }
  const entries: SafeZipEntry[] = [];
  const seenPaths = new Set<string>();
  let cursor = location.offset;
  const end = location.offset + location.size;
  for (let index = 0; index < location.entries; index += 1) {
    assertRange(bytes, cursor, 46, "central-directory entry");
    if (u32(bytes, cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`Malformed ZIP central-directory entry at offset ${cursor}.`);
    }
    const versionMadeBy = u16(bytes, cursor + 4);
    const flags = u16(bytes, cursor + 8);
    const compressionMethod = u16(bytes, cursor + 10);
    const crc32Value = u32(bytes, cursor + 16);
    let compressedSize = u32(bytes, cursor + 20);
    let uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const diskStart = u16(bytes, cursor + 34);
    const externalAttributes = u32(bytes, cursor + 38);
    let localHeaderOffset = u32(bytes, cursor + 42);
    const recordSize = 46 + nameLength + extraLength + commentLength;
    assertRange(bytes, cursor, recordSize, "central-directory entry");
    if (diskStart !== 0 && diskStart !== 0xffff) throw new Error("Multi-disk ZIP entries are not supported.");
    if ((flags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0) {
      throw new Error("Encrypted ZIP entries are not supported; preserve the archive for an encrypted archive store.");
    }
    if ((flags & ~(UTF8_FLAG | DATA_DESCRIPTOR_FLAG | 0x0006)) !== 0) {
      throw new Error(`ZIP entry uses unsupported flags: 0x${flags.toString(16)}.`);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`ZIP entry uses unsupported compression method ${compressionMethod}.`);
    }

    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const path = decodeEntryName(nameBytes, flags);
    const isDirectory = validateEntryPath(path, versionMadeBy, externalAttributes);
    const extra = bytes.slice(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    const zip64 = parseZip64Extra(extra, {
      uncompressedSize: uncompressedSize === 0xffffffff,
      compressedSize: compressedSize === 0xffffffff,
      localHeaderOffset: localHeaderOffset === 0xffffffff,
      diskStart: diskStart === 0xffff,
    });
    if (compressedSize === 0xffffffff) compressedSize = zip64.compressedSize ?? failZip64(path, "compressed size");
    if (uncompressedSize === 0xffffffff) {
      uncompressedSize = zip64.uncompressedSize ?? failZip64(path, "uncompressed size");
    }
    if (localHeaderOffset === 0xffffffff) {
      localHeaderOffset = zip64.localHeaderOffset ?? failZip64(path, "local-header offset");
    }
    if (zip64.diskStart !== undefined && zip64.diskStart !== 0) throw new Error("Multi-disk ZIP64 entries are not supported.");
    if (!Number.isSafeInteger(compressedSize) || !Number.isSafeInteger(uncompressedSize) || !Number.isSafeInteger(localHeaderOffset)) {
      throw new Error(`ZIP entry ${path} exceeds safe numeric bounds.`);
    }
    if (isDirectory && uncompressedSize !== 0) {
      throw new Error(`ZIP directory entry ${path} has file data.`);
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new Error(`ZIP entry ${path} exceeds the ${limits.maxEntryBytes} byte safety limit.`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw new Error(`ZIP entry ${path} exceeds the ${limits.maxCompressionRatio}x expansion-ratio safety limit.`);
    }
    if (seenPaths.has(path)) throw new Error(`ZIP archive contains duplicate entry path ${path}.`);
    seenPaths.add(path);
    const entry: SafeZipEntry = {
      path,
      entryId: `google-takeout/entry/${encodeURIComponent(path)}`,
      isDirectory,
      compressedSize,
      uncompressedSize,
      compressionMethod: compressionMethod as 0 | 8,
      crc32: crc32Value,
      flags,
      externalAttributes,
      localHeaderOffset,
      compressedSha256: sha256(compressedDataForFingerprint(bytes, localHeaderOffset, compressedSize, path)),
    };
    if (isDirectory) readEntryBytes(bytes, entry, { ...limits, maxEntryBytes: 1 });
    entries.push(entry);
    cursor += recordSize;
  }
  if (cursor !== end) throw new Error("ZIP central-directory size does not match its entries.");
  return entries;
}

function parseZip64Extra(
  extra: Uint8Array,
  required: { uncompressedSize: boolean; compressedSize: boolean; localHeaderOffset: boolean; diskStart: boolean },
): {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
  diskStart?: number;
} {
  let cursor = 0;
  const result: {
    uncompressedSize?: number;
    compressedSize?: number;
    localHeaderOffset?: number;
    diskStart?: number;
  } = {};
  while (cursor + 4 <= extra.length) {
    const id = u16(extra, cursor);
    const size = u16(extra, cursor + 2);
    cursor += 4;
    if (cursor + size > extra.length) throw new Error("Malformed ZIP extra field.");
    if (id === ZIP64_EXTRA_FIELD) {
      let fieldOffset = cursor;
      for (const field of ["uncompressedSize", "compressedSize", "localHeaderOffset"] as const) {
        if (!required[field]) continue;
        if (fieldOffset + 8 > cursor + size) throw new Error(`ZIP64 ${field} is missing.`);
        result[field] = safeNumber(u64(extra, fieldOffset), `ZIP64 ${field}`);
        fieldOffset += 8;
      }
      if (required.diskStart) {
        if (fieldOffset + 4 > cursor + size) throw new Error("ZIP64 disk-start value is missing.");
        result.diskStart = u32(extra, fieldOffset);
      }
    }
    cursor += size;
  }
  if (cursor !== extra.length) throw new Error("Malformed ZIP extra-field length.");
  return result;
}

function compressedDataForFingerprint(
  archive: Uint8Array,
  localHeaderOffset: number,
  compressedSize: number,
  path: string,
): Uint8Array {
  assertRange(archive, localHeaderOffset, 30, `local header for ${path}`);
  if (u32(archive, localHeaderOffset) !== LOCAL_FILE_HEADER) throw new Error(`Malformed local header for ZIP entry ${path}.`);
  const nameLength = u16(archive, localHeaderOffset + 26);
  const extraLength = u16(archive, localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
  return sliceRange(archive, dataOffset, compressedSize, path, false);
}

function readEntryBytes(
  archive: Uint8Array,
  entry: SafeZipEntry,
  limits: Required<ZipSafetyLimits>,
): Uint8Array {
  assertRange(archive, entry.localHeaderOffset, 30, `local header for ${entry.path}`);
  const localOffset = entry.localHeaderOffset;
  if (u32(archive, localOffset) !== LOCAL_FILE_HEADER) throw new Error(`Malformed local header for ZIP entry ${entry.path}.`);
  const localFlags = u16(archive, localOffset + 6);
  const localMethod = u16(archive, localOffset + 8);
  const localNameLength = u16(archive, localOffset + 26);
  const localExtraLength = u16(archive, localOffset + 28);
  const localRecordLength = 30 + localNameLength + localExtraLength;
  assertRange(archive, localOffset, localRecordLength, `local header for ${entry.path}`);
  const localName = decodeEntryName(archive.slice(localOffset + 30, localOffset + 30 + localNameLength), localFlags);
  if (localName !== entry.path || localFlags !== entry.flags || localMethod !== entry.compressionMethod) {
    throw new Error(`ZIP local header disagrees with central-directory entry ${entry.path}.`);
  }
  const dataOffset = localOffset + localRecordLength;
  const compressed = sliceRange(archive, dataOffset, entry.compressedSize, entry.path, false);
  let output: Uint8Array;
  if (entry.compressionMethod === 0) {
    output = new Uint8Array(compressed);
  } else {
    output = inflateRaw(compressed, entry.path, limits.maxEntryBytes);
  }
  if (output.byteLength !== entry.uncompressedSize || output.byteLength > limits.maxEntryBytes) {
    throw new Error(`ZIP entry ${entry.path} expanded to an unexpected size.`);
  }
  if (crc32(output) !== entry.crc32) throw new Error(`ZIP entry ${entry.path} failed its CRC32 check.`);
  return output;
}

function inflateRaw(compressed: Uint8Array, path: string, maxOutputLength: number): Uint8Array {
  try {
    return inflateRawSync(compressed, { maxOutputLength });
  } catch (error) {
    throw new Error(`ZIP entry ${path} has malformed deflate data: ${errorMessage(error)}`);
  }
}

function decodeEntryName(bytes: Uint8Array, flags: number): string {
  if (bytes.includes(0)) throw new Error("ZIP entry path contains a NUL byte.");
  if ((flags & UTF8_FLAG) !== 0) {
    try {
      return textDecoder.decode(bytes);
    } catch {
      throw new Error("ZIP entry path is not valid UTF-8.");
    }
  }
  // Google Takeout paths are ASCII. Refusing ambiguous legacy code pages keeps
  // path validation deterministic and avoids two names mapping to one ID.
  if (bytes.some((byte) => byte > 0x7f)) throw new Error("ZIP entry uses an unsupported non-UTF-8 path.");
  return new TextDecoder().decode(bytes);
}

function validateEntryPath(path: string, versionMadeBy: number, externalAttributes: number): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`ZIP entry path is unsafe: ${path || "<empty>"}.`);
  }
  const isDirectoryName = path.endsWith("/");
  const segments = path.split("/");
  const meaningfulSegments = isDirectoryName ? path.replace(/\/+$/, "").split("/") : segments;
  if (meaningfulSegments.length === 0 || meaningfulSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`ZIP entry path is unsafe: ${path}.`);
  }
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const unixType = (versionMadeBy >>> 8) === 3 ? unixMode & 0xf000 : 0;
  if (unixType === 0xa000) throw new Error(`ZIP symbolic-link entry is not allowed: ${path}.`);
  if (unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000) {
    throw new Error(`ZIP entry has an unsupported Unix file type: ${path}.`);
  }
  const dosDirectory = (versionMadeBy >>> 8) !== 3 && (externalAttributes & 0x10) !== 0;
  const isDirectory = isDirectoryName || unixType === 0x4000 || dosDirectory;
  if (isDirectory && !isDirectoryName) throw new Error(`ZIP directory entry must end with '/': ${path}.`);
  return isDirectory;
}

function failZip64(path: string, field: string): never {
  throw new Error(`ZIP64 ${field} is missing for entry ${path}.`);
}

function sliceRange(bytes: Uint8Array, offset: number, length: number, label: string, localHeader: boolean): Uint8Array {
  const start = localHeader ? offset + 30 : offset;
  assertRange(bytes, start, length, localHeader ? `compressed data for ${label}` : label);
  return bytes.slice(start, start + length);
}

function assertRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`ZIP ${label} lies outside the archive.`);
  }
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds JavaScript safe numeric bounds.`);
  return Number(value);
}

function u16(bytes: Uint8Array, offset: number): number {
  assertRange(bytes, offset, 2, "integer");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  assertRange(bytes, offset, 4, "integer");
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function u64(bytes: Uint8Array, offset: number): bigint {
  assertRange(bytes, offset, 8, "integer");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  return Bun.hash.crc32(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
