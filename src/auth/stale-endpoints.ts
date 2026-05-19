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

/** Why the endpoint was marked stale. The agent reads this to know what
 *  action will refresh it — login flow (401/403) or just a re-capture
 *  (cookie expired with no auth failure observed). */
export type StaleReason = "auth_failed_401" | "auth_failed_403" | "auth_failed_other" | "cookie_expired";

export interface StaleRecord {
  domain: string;
  endpoint_id: string;
  ts: number;
  status: number;
  cookie_source: CookieSource;
  /** Loop 5.1: why this endpoint is stale. Derived from status when
   *  recorded via execute (401/403/other) or set explicitly for
   *  cookie-expiry detection. */
  reason: StaleReason;
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
 *  (domain, endpoint_id) pair and prunes expired rows on write.
 *  `reason` is derived from `status` when not provided. */
export function recordStaleEndpoint(
  domain: string,
  endpoint_id: string,
  status: number,
  cookie_source: CookieSource = "unknown",
  now: number = Date.now(),
  reason?: StaleReason,
): void {
  if (!domain || !endpoint_id) return;
  const derivedReason: StaleReason = reason ?? (
    status === 401 ? "auth_failed_401" :
    status === 403 ? "auth_failed_403" :
    "auth_failed_other"
  );
  const existing = readRecords();
  const others = existing.filter((r) => !(r.domain === domain && r.endpoint_id === endpoint_id));
  others.push({ domain, endpoint_id, ts: now, status, cookie_source, reason: derivedReason });
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

/** Loop 5.1: structured auth hint surfaced to the agent when resolve
 *  filters stale endpoints. The agent reads this to know that login is
 *  required AND why (401 from server vs expired local cookies). Includes
 *  concrete next-step commands. Returns null when there's nothing to hint. */
export interface AuthHint {
  /** Always true when present — surface signal for templated agents. */
  login_required: true;
  domain: string;
  /** Why we know auth is needed. */
  reason: StaleReason;
  /** Human-readable message — safe to render to the agent UI. */
  message: string;
  /** Concrete commands that refresh credentials for this domain. */
  next_step: string;
  commands: string[];
}

function reasonMessage(reason: StaleReason, domain: string): string {
  switch (reason) {
    case "auth_failed_401":
      return `${domain} returned HTTP 401 — your saved cookies are stale or signed-out. Log in again to refresh.`;
    case "auth_failed_403":
      return `${domain} returned HTTP 403 — your account doesn't have access or the session was revoked. Log in again.`;
    case "cookie_expired":
      return `Your cookies for ${domain} have expired locally. Log in again to refresh them.`;
    case "auth_failed_other":
      return `${domain} rejected authenticated requests. Log in again to refresh credentials.`;
  }
}

/** Build an AuthHint for a domain by reading the freshest stale record.
 *  Returns null when there are no stale records for the domain. */
export function buildAuthHint(domain: string, now: number = Date.now()): AuthHint | null {
  if (!domain) return null;
  const records = listStaleEndpoints(domain, now);
  if (records.length === 0) return null;
  // Pick the most recent record — that's the freshest evidence of why
  // the agent is being shown a hint right now.
  const latest = records.reduce((a, b) => (a.ts >= b.ts ? a : b));
  const loginUrl = `https://${domain}/`;
  return {
    login_required: true,
    domain,
    reason: latest.reason,
    message: reasonMessage(latest.reason, domain),
    next_step: `Run \`unbrowse go "${loginUrl}"\` and complete the login in the browser, then \`unbrowse close\` to checkpoint fresh cookies.`,
    commands: [
      `unbrowse go "${loginUrl}"`,
      "unbrowse snap --filter interactive",
      "unbrowse close",
    ],
  };
}

/** Loop 5.1: when cookies for a domain are observed to be expired
 *  (c.expires < now), mark the stale signal even before any execute
 *  attempt. Caller passes one canonical endpoint_id (or just the
 *  domain root) — the (domain, endpoint_id) row carries reason
 *  "cookie_expired". Returns count of stale-marked records.
 *
 *  Inputs are bring-your-own-cookies — the substrate doesn't reach
 *  into the user's browser; the caller already has the cookie list. */
export function markCookieExpiry(
  domain: string,
  cookies: ReadonlyArray<{ name: string; expires?: number; httpOnly?: boolean; secure?: boolean }>,
  endpointIds: ReadonlyArray<string>,
  now: number = Date.now(),
): number {
  if (!domain || endpointIds.length === 0) return 0;
  const nowSec = Math.floor(now / 1000);
  // A session is "expired" when at least one auth-shaped cookie has
  // an explicit expires < now. Skip cookies with expires=0/undefined
  // (session cookies — only valid for the browser tab's lifetime,
  // we can't judge expiry from disk alone).
  const expiredAuthLike = cookies.some((c) => {
    if (!c.expires || c.expires <= 0) return false;
    if (c.expires >= nowSec) return false;
    // Only count cookies likely to be the auth substrate — http_only OR
    // secure cookies are typically the session bearers.
    return c.httpOnly === true || c.secure === true;
  });
  if (!expiredAuthLike) return 0;
  for (const ep of endpointIds) {
    recordStaleEndpoint(domain, ep, 0, "local-browser", now, "cookie_expired");
  }
  return endpointIds.length;
}
