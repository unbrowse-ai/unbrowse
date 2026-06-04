import { Buffer } from "node:buffer";

export type ProtobufJsonValue = string | number | boolean | null | ProtobufJsonValue[] | { [key: string]: ProtobufJsonValue };

export interface ProtobufDecodeResult {
  protobuf_decoded: true;
  encoding: "base64" | "latin1" | "utf8" | "bytes";
  byte_length: number;
  field_count: number;
  fields: Record<string, ProtobufJsonValue>;
  records: Array<Record<string, ProtobufJsonValue>>;
}

const MAX_DEPTH = 6;
const MAX_FIELDS = 2_000;
const MAX_RECORDS = 30;

export function isProtobufContentType(contentType?: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("protobuf") || ct.includes("x-protobuf") || ct.includes("proto;") || ct.includes("proto+");
}

export function isProtobufLikeEndpoint(url: string, contentType?: string): boolean {
  if (isProtobufContentType(contentType)) return true;
  return /\/(field-data-proto|proto|protobuf)(\/|$|-)/i.test(url);
}

export function decodeProtobufBody(body: string | Uint8Array | ArrayBuffer, contentType?: string): ProtobufDecodeResult | null {
  const candidates = bodyToCandidates(body, contentType);
  let best: ProtobufDecodeResult | null = null;
  for (const candidate of candidates) {
    const decoded = decodeBytes(candidate.bytes, candidate.encoding);
    if (!decoded) continue;
    if (!best || scoreDecoded(decoded) > scoreDecoded(best)) best = decoded;
  }
  return best;
}

export function decodeProtobufBytes(bytes: Uint8Array): ProtobufDecodeResult | null {
  return decodeBytes(bytes, "bytes");
}

function bodyToCandidates(body: string | Uint8Array | ArrayBuffer, contentType?: string): Array<{ encoding: ProtobufDecodeResult["encoding"]; bytes: Uint8Array }> {
  if (body instanceof Uint8Array) return [{ encoding: "bytes", bytes: body }];
  if (body instanceof ArrayBuffer) return [{ encoding: "bytes", bytes: new Uint8Array(body) }];

  const trimmed = body.trim();
  const out: Array<{ encoding: ProtobufDecodeResult["encoding"]; bytes: Uint8Array }> = [];
  const explicitBase64 = trimmed.match(/^(?:unbrowse:)?base64[:,](.+)$/i)?.[1] ?? trimmed.match(/^data:[^;]+;base64,(.+)$/i)?.[1];
  if (explicitBase64) {
    out.push({ encoding: "base64", bytes: decodeBase64(explicitBase64) });
  } else if (looksBase64(trimmed, contentType)) {
    out.push({ encoding: "base64", bytes: decodeBase64(trimmed) });
  }
  out.push({ encoding: "latin1", bytes: Buffer.from(body, "latin1") });
  out.push({ encoding: "utf8", bytes: Buffer.from(body, "utf8") });
  return out.filter((candidate) => candidate.bytes.length > 0);
}

function looksBase64(value: string, contentType?: string): boolean {
  if (value.length < 8 || value.length % 4 === 1) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  if (/^[\[{<]/.test(value)) return false;
  return isProtobufContentType(contentType) || /={0,2}$/.test(value);
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function decodeBytes(bytes: Uint8Array, encoding: ProtobufDecodeResult["encoding"]): ProtobufDecodeResult | null {
  try {
    const parsed = parseMessage(bytes, 0, bytes.length, 0);
    if (parsed.offset !== bytes.length || parsed.fieldCount === 0) return null;
    const fields = collapseFields(parsed.fields);
    const records = extractLikelyRecords(fields);
    return {
      protobuf_decoded: true,
      encoding,
      byte_length: bytes.length,
      field_count: parsed.fieldCount,
      fields,
      records,
    };
  } catch {
    return null;
  }
}

type FieldMap = Map<string, ProtobufJsonValue[]>;

function parseMessage(bytes: Uint8Array, start: number, end: number, depth: number): { fields: FieldMap; offset: number; fieldCount: number } {
  if (depth > MAX_DEPTH) throw new Error("protobuf depth limit");
  const fields: FieldMap = new Map();
  let offset = start;
  let fieldCount = 0;
  while (offset < end) {
    if (fieldCount >= MAX_FIELDS) throw new Error("protobuf field limit");
    const tag = readVarint(bytes, offset, end);
    offset = tag.offset;
    const tagValue = Number(tag.value);
    const fieldNo = tagValue >>> 3;
    const wireType = tagValue & 0x7;
    if (fieldNo <= 0 || fieldNo > 536_870_911) throw new Error("invalid protobuf field");
    let value: ProtobufJsonValue;
    switch (wireType) {
      case 0: {
        const next = readVarint(bytes, offset, end);
        offset = next.offset;
        value = bigintToJson(next.value);
        break;
      }
      case 1: {
        if (offset + 8 > end) throw new Error("truncated fixed64");
        value = readFixed64(bytes, offset);
        offset += 8;
        break;
      }
      case 2: {
        const len = readVarint(bytes, offset, end);
        offset = len.offset;
        const length = Number(len.value);
        if (!Number.isSafeInteger(length) || length < 0 || offset + length > end) throw new Error("invalid length");
        const chunk = bytes.slice(offset, offset + length);
        offset += length;
        value = decodeLengthDelimited(chunk, depth + 1);
        break;
      }
      case 5: {
        if (offset + 4 > end) throw new Error("truncated fixed32");
        value = readFixed32(bytes, offset);
        offset += 4;
        break;
      }
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
    const key = `field_${fieldNo}`;
    const arr = fields.get(key) ?? [];
    arr.push(value);
    fields.set(key, arr);
    fieldCount++;
  }
  return { fields, offset, fieldCount };
}

function readVarint(bytes: Uint8Array, offset: number, end: number): { value: bigint; offset: number } {
  let shift = 0n;
  let value = 0n;
  while (offset < end && shift <= 63n) {
    const b = bytes[offset++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("invalid varint");
}

function bigintToJson(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function readFixed32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readFixed64(bytes: Uint8Array, offset: number): string {
  const low = BigInt(readFixed32(bytes, offset));
  const high = BigInt(readFixed32(bytes, offset + 4));
  return ((high << 32n) | low).toString();
}

function decodeLengthDelimited(bytes: Uint8Array, depth: number): ProtobufJsonValue {
  if (bytes.length === 0) return "";
  const nested = tryDecodeNested(bytes, depth);
  if (nested) return nested;
  const text = decodeUtf8IfPrintable(bytes);
  if (text != null) return text;
  return `base64:${Buffer.from(bytes).toString("base64")}`;
}

function tryDecodeNested(bytes: Uint8Array, depth: number): Record<string, ProtobufJsonValue> | null {
  if (bytes.length < 2 || depth > MAX_DEPTH) return null;
  try {
    const nested = parseMessage(bytes, 0, bytes.length, depth);
    if (nested.offset !== bytes.length || nested.fieldCount === 0) return null;
    return collapseFields(nested.fields);
  } catch {
    return null;
  }
}

function decodeUtf8IfPrintable(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text || text.includes("\uFFFD")) return null;
  let printable = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
  }
  return printable / text.length >= 0.85 ? text : null;
}

function collapseFields(fields: FieldMap): Record<string, ProtobufJsonValue> {
  const out: Record<string, ProtobufJsonValue> = {};
  for (const [key, values] of fields.entries()) {
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

function scoreDecoded(decoded: ProtobufDecodeResult): number {
  return decoded.field_count + decoded.records.length * 10 + JSON.stringify(decoded.fields).length / 1_000;
}

function extractLikelyRecords(root: ProtobufJsonValue): Array<Record<string, ProtobufJsonValue>> {
  const records: Array<Record<string, ProtobufJsonValue>> = [];
  const visit = (value: ProtobufJsonValue, depth: number) => {
    if (records.length >= MAX_RECORDS || depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const candidate = summarizeRecord(value);
    if (candidate) records.push(candidate);
    for (const next of Object.values(value)) visit(next, depth + 1);
  };
  visit(root, 0);
  return records;
}

function summarizeRecord(obj: Record<string, ProtobufJsonValue>): Record<string, ProtobufJsonValue> | null {
  const strings: string[] = [];
  const numbers: number[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === "string") strings.push(value);
    if (typeof value === "number") numbers.push(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") strings.push(item);
        if (typeof item === "number") numbers.push(item);
      }
    }
  }
  const usefulStrings = Array.from(new Set(strings.filter((s) => s.length >= 2 && s.length <= 240))).slice(0, 10);
  const usefulNumbers = Array.from(new Set(numbers.filter((n) => Number.isFinite(n)))).slice(0, 10);
  const urlLike = usefulStrings.find((s) => /^https?:\/\//i.test(s));
  const imageLike = usefulStrings.find((s) => /\.(png|jpe?g|webp|avif)(\?|$)/i.test(s) || /image|img|photo|thumb/i.test(s));
  const titleLike = usefulStrings
    .filter((s) => !/^https?:\/\//i.test(s))
    .sort((a, b) => b.length - a.length)[0];
  const priceLike = usefulNumbers.find((n) => n > 0 && n < 1_000_000);
  if (usefulStrings.length < 2 && !(titleLike && priceLike) && !urlLike && !imageLike) return null;
  return {
    ...(titleLike ? { title_like: titleLike } : {}),
    ...(priceLike != null ? { price_like: priceLike } : {}),
    ...(urlLike ? { url_like: urlLike } : {}),
    ...(imageLike ? { image_like: imageLike } : {}),
    text: usefulStrings,
    numbers: usefulNumbers,
  };
}

function collectPrimitives(value: ProtobufJsonValue, strings: string[], numbers: number[], depth: number): void {
  if (depth > 3 || value == null) return;
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (typeof value === "number") {
    numbers.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 12)) collectPrimitives(item, strings, numbers, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value).slice(0, 20)) collectPrimitives(item, strings, numbers, depth + 1);
  }
}
