import { Buffer } from "node:buffer";
import {
  decodeProtobufBody,
  decodeProtobufBytes,
  decodesToProtobufRecords,
  type ProtobufDecodeResult,
} from "../src/protobuf/wire.js";

const MAX_INPUT_SIZE = 64 * 1024;

function assertResult(result: ProtobufDecodeResult | null, inputLength: number): void {
  if (result === null) return;
  if (result.protobuf_decoded !== true) throw new Error("decoded result lacks protobuf marker");
  if (result.byte_length !== inputLength) throw new Error("decoded byte length drifted from input");
  if (result.field_count < 1 || result.field_count > 2_000) throw new Error("decoded field limit violated");
  if (result.records.length > 30) throw new Error("decoded record limit violated");
  JSON.stringify(result);
}

/** Coverage-guided target for the untrusted protobuf response boundary. */
export function fuzz(data: Buffer): void {
  if (data.length > MAX_INPUT_SIZE) return;

  const bytes = new Uint8Array(data);
  const first = decodeProtobufBytes(bytes);
  const second = decodeProtobufBytes(new Uint8Array(bytes));
  assertResult(first, bytes.length);
  assertResult(second, bytes.length);

  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("protobuf decoding is non-deterministic");
  }

  const fromArrayBuffer = decodeProtobufBody(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assertResult(fromArrayBuffer, bytes.length);
  if (JSON.stringify(first) !== JSON.stringify(fromArrayBuffer)) {
    throw new Error("Uint8Array and ArrayBuffer decoding disagree");
  }

  const admitsRecords = decodesToProtobufRecords(bytes);
  if (admitsRecords !== Boolean(first?.records.length)) {
    throw new Error("protobuf structural admission disagrees with decoder");
  }
}
