import { Buffer } from "node:buffer";
import { extractRscDataEndpoints, isRscPayload, parseRscPayload } from "../src/capture/rsc.js";

const MAX_INPUT_SIZE = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Coverage-guided target for React Server Components wire responses. */
export function fuzz(data: Buffer): void {
  if (data.length > MAX_INPUT_SIZE) return;
  const text = decoder.decode(data);
  const chunks = parseRscPayload(text);
  const repeated = parseRscPayload(text);
  const endpoints = extractRscDataEndpoints(text);

  if (JSON.stringify(chunks) !== JSON.stringify(repeated)) {
    throw new Error("RSC parsing is non-deterministic");
  }
  const nonEmptyLines = text.split("\n").filter((line) => line.trim()).length;
  if (chunks.length > nonEmptyLines) throw new Error("RSC parser emitted too many chunks");
  for (const chunk of chunks) {
    if (!/^\d+$/.test(chunk.id)) throw new Error("RSC parser emitted a non-numeric chunk id");
  }
  if (new Set(endpoints).size !== endpoints.length) throw new Error("RSC endpoint extraction returned duplicates");
  for (const endpoint of endpoints) {
    if (!/^https?:\/\//.test(endpoint)) throw new Error("RSC endpoint extraction returned a non-HTTP URL");
  }
  if (isRscPayload(text) && chunks.length === 0) throw new Error("RSC detector/parser disagreement");
  JSON.stringify({ chunks, endpoints });
}
