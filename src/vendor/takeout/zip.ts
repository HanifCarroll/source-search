import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {BlobReader,ZipReader,type FileEntry} from '@zip.js/zip.js';

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

export async function loadSafeZipArchive(input:string|Uint8Array,options:ZipSafetyLimits={}):Promise<SafeZipArchive>{
  const limits=resolveLimits(options);
  const stat=typeof input==='string' ? await lstat(input) : undefined;
  if(stat && (!stat.isFile() || stat.isSymbolicLink()))throw Error('ZIP archive input must be a regular file, not a symbolic link.');
  const blob=typeof input==='string' ? Bun.file(input) : new Blob([new Uint8Array(input)]);
  if(blob.size>limits.maxArchiveBytes)throw Error(`ZIP archive exceeds the ${limits.maxArchiveBytes} byte safety limit.`);
  if(!blob.size)throw Error('ZIP archive is empty.');
  const unchanged=async()=>{
    if(typeof input!=='string' || !stat)return;
    const after=await lstat(input);
    if(after.isSymbolicLink() || after.ino!==stat.ino || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs)throw Error('ZIP archive changed while it was being read.');
  };
  const reader=new ZipReader(new BlobReader(blob),{checkCrc32:true,checkAmbiguity:true,filenameValidation:'balanced',useWebWorkers:false});
  const entries:SafeZipEntry[]=[],native=new Map<string,FileEntry>();
  let totalDeclaredUncompressedBytes=0;
  try{
    for await(const value of reader.getEntriesGenerator()){
      // zip.js exposes getData on directories too; its public union omits it.
      const entry=value as FileEntry;
      if(entries.length>=limits.maxEntries)throw Error('ZIP archive exceeds the entry count safety limit.');
      const flags=entry.rawBitFlag||0;
      if(entry.encrypted || (flags & 0x41))throw Error('Encrypted ZIP entries are not supported.');
      if((flags & ~(0x0800|0x0008|0x0006))!==0)throw Error('Unsupported ZIP flags.');
      if(entry.compressionMethod!==0 && entry.compressionMethod!==8)throw Error('Unsupported ZIP compression method.');
      // Preserve deterministic export identities instead of guessing legacy encodings.
      const rawName=entry.rawFilename;
      if(!(flags&0x0800) && rawName.some(b=>b>127))throw Error('ZIP entry uses an unsupported non-UTF-8 path.');
      const path=new TextDecoder('utf-8',{fatal:true}).decode(rawName);
      if(path!==entry.filename || path.includes('\0'))throw Error('ZIP entry path is unsafe or ambiguous.');
      const isDirectory=validateEntryPath(path,entry.versionMadeBy,entry.externalFileAttributes);
      if(isDirectory && entry.uncompressedSize!==0)throw Error(`ZIP directory entry ${path} has file data.`);
      if(entry.uncompressedSize>limits.maxEntryBytes)throw Error(`ZIP entry ${path} exceeds the byte safety limit.`);
      if(entry.uncompressedSize/Math.max(1,entry.compressedSize)>limits.maxCompressionRatio)throw Error('ZIP entry exceeds the expansion-ratio safety limit.');
      totalDeclaredUncompressedBytes+=entry.uncompressedSize;
      if(totalDeclaredUncompressedBytes>limits.maxTotalUncompressedBytes)throw Error('ZIP archive exceeds the total uncompressed byte safety limit.');
      // Validate local headers and overlap using zip.js without inflating media.
      await entry.getData(new WritableStream(),{checkOverlappingEntryOnly:true});
      const dataOffset=entry.localDirectory!.dataOffset;
      const compressedSha256=await digest(blob.slice(dataOffset,dataOffset+entry.compressedSize));
      const safe:SafeZipEntry={path,entryId:`google-takeout/entry/${encodeURIComponent(path)}`,isDirectory,compressedSize:entry.compressedSize,uncompressedSize:entry.uncompressedSize,compressionMethod:entry.compressionMethod,crc32:entry.signature!,flags,externalAttributes:entry.externalFileAttributes,localHeaderOffset:entry.offset,compressedSha256};
      entries.push(safe);native.set(safe.entryId,entry);
      // Empty compressed directories still need deflate and CRC validation.
      if(isDirectory)await extract(entry,1);
    }
    const archiveSha256=await digest(blob);
    await unchanged();
    return {archiveBytes:blob.size,archiveSha256,entries,totalDeclaredUncompressedBytes,limits,async readEntry(request){
      const known=entries.find(e=>e.entryId===request.entryId),entry=native.get(request.entryId);
      if(!known || !entry)throw Error('Unknown ZIP entry.');
      await unchanged();
      try{
        const data=await extract(entry,limits.maxEntryBytes);
        await unchanged();known.sha256=createHash('sha256').update(data).digest('hex');return data;
      }finally{await reader.close();}
    }};
  }finally{
    // BlobReader has no persistent file descriptor. close releases codecs; entry
    // reads remain usable and close their own codec resources afterwards.
    await reader.close();
  }
}
export const parseSafeZipArchive=loadSafeZipArchive;
async function digest(blob:Blob){
  const hash=createHash('sha256');for await(const chunk of blob.stream())hash.update(chunk);return hash.digest('hex');
}
async function extract(entry:FileEntry,limit:number){
  const chunks:Uint8Array[]=[];let length=0;
  await entry.getData(new WritableStream<Uint8Array>({write(chunk){
    length+=chunk.length;
    if(length>limit || length>entry.uncompressedSize)throw Error('ZIP entry expanded beyond its byte safety limit.');
    chunks.push(chunk);
  }}),{checkCrc32:true});
  if(length!==entry.uncompressedSize)throw Error('ZIP entry expanded to an unexpected size.');
  const output=new Uint8Array(length);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
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
