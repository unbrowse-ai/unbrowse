import { Buffer } from "node:buffer";
import { parseObscuraCapture } from "../src/capture/obscura-capture.js";

const MAX_INPUT_SIZE = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Coverage-guided target for native-sidecar NDJSON, an external process boundary. */
export function fuzz(data: Buffer): void {
  if (data.length > MAX_INPUT_SIZE) return;
  const text = decoder.decode(data);
  const first = parseObscuraCapture(text);
  const second = parseObscuraCapture(text);

  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("obscura capture parsing is non-deterministic");
  }
  const nonEmptyLines = text.split("\n").filter((line) => line.trim()).length;
  if (first.requests.length > nonEmptyLines) {
    throw new Error("parser emitted more requests than input records");
  }
  for (const request of first.requests) {
    if (typeof request.url !== "string" || typeof request.method !== "string") {
      throw new Error("parser admitted an invalid response record");
    }
    if (!Number.isFinite(request.response_status)) {
      throw new Error("parser admitted an invalid response status");
    }
    if (Number.isNaN(Date.parse(request.timestamp))) {
      throw new Error("parser emitted an invalid timestamp");
    }
  }
  JSON.stringify(first);
}
