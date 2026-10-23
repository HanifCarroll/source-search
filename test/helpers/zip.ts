import { deflateRawSync } from "node:zlib";
type FixtureEntry = { path: string; text: string; method?: 0 | 8; externalAttributes?: number };
export async function createZip(entries: FixtureEntry[]): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const raw = new TextEncoder().encode(entry.text);
    const compressed = entry.method === 8 ? deflateRawSync(raw) : raw;
    const checksum = crc32(raw);
    const local = new Uint8Array(30 + name.length + compressed.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, 0x800);
    writeU16(local, 8, entry.method ?? 0);
    writeU32(local, 14, checksum);
    writeU32(local, 18, compressed.length);
    writeU32(local, 22, raw.length);
    writeU16(local, 26, name.length);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 0x0314);
    writeU16(central, 6, 20);
    writeU16(central, 8, 0x800);
    writeU16(central, 10, entry.method ?? 0);
    writeU32(central, 16, checksum);
    writeU32(central, 20, compressed.length);
    writeU32(central, 24, raw.length);
    writeU16(central, 28, name.length);
    writeU32(central, 38, entry.externalAttributes ?? 0x81a40000);
    writeU32(central, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 8, entries.length);
  writeU16(end, 10, entries.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, offset);
  return concat([...localParts, ...centralParts, end]);
}


function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
