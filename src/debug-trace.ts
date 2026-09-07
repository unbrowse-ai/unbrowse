import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";

const TRACE_DIR = process.env.TRACES_DIR ?? join(process.cwd(), "traces");

export function writeDebugTrace(kind: string, payload: unknown): string | null {
  if (process.env.UNBROWSE_TRACE_DEBUG !== "1") return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(TRACE_DIR, `${stamp}-${kind}-${nanoid(6)}.json`);
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
    return file;
  } catch {
    return null;
  }
}
