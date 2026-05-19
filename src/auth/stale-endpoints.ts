// Loop 5 (B-023 follow-up #2): 401-feedback signal.
//
// User insight: "401 should just identify that the user's remote/local
// cookies are stale and hide it from actually being surfaced."
//
// PR #517's auth_walled signal pre-detected from HTML body shape. That
// works for new captures, but legacy cached marketplace endpoints lack
// the flag and keep surfacing. The TRUTH signal is what execute saw —
// a real 401/403 from the server after credentials were refreshed.
//
// This substrate persists the (domain, endpoint_id) pairs that returned
// auth-shaped failures within a recent window. Resolve filters them out
// of `available_endpoints` so the agent never sees a callable-looking
// endpoint that we already know will 401. Stale records expire by TTL
// so a successful re-auth (fresh capture, vault refresh, browser cookie
// refresh) restores visibility on the next read.
//
// Storage shape: a tiny JSON file at
// `$UNBROWSE_STALE_ENDPOINTS_PATH` (or `~/.unbrowse/stale-endpoints.json`)
// with one row per `(domain, endpoint_id)`. Best-effort; never throws into
// the caller's hot path.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const STALE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type CookieSource = "local-browser" | "remote-vault" | "unknown";

export interface StaleRecord {
  domain: string;
  endpoint_id: string;
  ts: number;
  status: number;
  cookie_source: CookieSource;
}

function staleFilePath(): string {
  return process.env.UNBROWSE_STALE_ENDPOINTS_PATH ??
    path.join(os.homedir(), ".unbrowse", "stale-endpoints.json");
}

function readRecords(): StaleRecord[] {
  try {
    const raw = fs.readFileSync(staleFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StaleRecord[]) : [];
  } catch {
    return [];
  }
}

function writeRecords(records: StaleRecord[]): void {
  try {
    const file = staleFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
  } catch {
    /* best-effort; never throw into the caller's hot path */
  }
}

/** Mark an endpoint stale. Replaces any prior row for the same
 *  (domain, endpoint_id) pair and prunes expired rows on write. */
export function recordStaleEndpoint(
  domain: string,
  endpoint_id: string,
  status: number,
  cookie_source: CookieSource = "unknown",
  now: number = Date.now(),
): void {
  if (!domain || !endpoint_id) return;
  const existing = readRecords();
  const others = existing.filter((r) => !(r.domain === domain && r.endpoint_id === endpoint_id));
  others.push({ domain, endpoint_id, ts: now, status, cookie_source });
  const fresh = others.filter((r) => (now - r.ts) < STALE_TTL_MS);
  writeRecords(fresh);
}

/** TRUE if (domain, endpoint_id) has a non-expired stale record. */
export function isEndpointStale(
  domain: string,
  endpoint_id: string,
  now: number = Date.now(),
): boolean {
  if (!domain || !endpoint_id) return false;
  const records = readRecords();
  return records.some((r) =>
    r.domain === domain &&
    r.endpoint_id === endpoint_id &&
    (now - r.ts) < STALE_TTL_MS,
  );
}

/** All non-expired stale records, optionally scoped to one domain. */
export function listStaleEndpoints(
  domain?: string,
  now: number = Date.now(),
): StaleRecord[] {
  return readRecords().filter((r) =>
    (now - r.ts) < STALE_TTL_MS && (!domain || r.domain === domain),
  );
}

/** Clear all records (test helper + manual reset). */
export function clearStaleEndpoints(): void {
  writeRecords([]);
}
