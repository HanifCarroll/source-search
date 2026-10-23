// Message decoding adapted from LifeOS; provenance is recorded in REUSE.md.
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
