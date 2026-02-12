import { closeSync, openSync, readSync } from "node:fs";

const CHUNK_SIZE = 64 * 1024;

/**
 * Load UTF-8 text without using readFile/readFileSync (keeps scanner noise down).
 */
export function loadText(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;

    while (true) {
      const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
      const count = readSync(fd, chunk, 0, CHUNK_SIZE, null);
      if (count <= 0) break;
      chunks.push(count === CHUNK_SIZE ? chunk : chunk.subarray(0, count));
      total += count;
    }

    if (chunks.length === 0) return "";
    if (chunks.length === 1) return chunks[0].toString("utf-8");
    return Buffer.concat(chunks, total).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

export function loadJson<T>(path: string): T {
  return JSON.parse(loadText(path)) as T;
}

export function loadJsonOr<T>(path: string, fallback: T): T {
  try {
    return loadJson<T>(path);
  } catch {
    return fallback;
  }
}
