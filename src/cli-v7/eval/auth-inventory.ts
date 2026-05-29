/**
 * `unbrowse eval auth-inventory` — per-domain AST of what the user can
 * already authenticate against, sourced from local browser profile
 * metadata (Chrome + Firefox cookies, history, bookmarks).
 *
 * 1:1 mapping (kind-map.ts row "eval auth-inventory"):
 *   CLI subcommand  : eval auth-inventory
 *   MCP tool        : unbrowse_auth_inventory
 *   Op kind   : eval:auth_inventory
 *   Verb            : eval (read-only)
 *   Cadence day     : Day 4 — Instrument (Gen 1:14 "lights for signs")
 *
 * ALWAYS-WRAP RULE (Num 13:18 — "See what the land is; and the people
 * who dwell therein, whether they are strong or weak"): auth-inventory
 * IS the scouting before the resolve+execute siege. The agent reads
 * this AST FIRST to bias the ranker toward domains with non-expired
 * auth cookies + high visit counts + bookmarks before driving any
 * browser-open path.
 *
 * SECURITY INVARIANTS (load-bearing — contract ee1f5409 substrate
 * pointer-not-payload, W3 secret-redaction):
 *   1. Cookie `value` / `encrypted_value` columns are NEVER selected.
 *      No keychain master-key extraction. Even if the column existed
 *      in scope, this handler would still never name it. The Chrome
 *      OS-keychain decryption path is explicitly OUT OF SCOPE.
 *   2. History URL paths are NEVER returned. Only hostnames. The
 *      `urls.url` column may contain `?token=...&session_id=...` and
 *      similar secrets — `hostnameFromUrl` parses-and-discards before
 *      any data leaves the per-source helper.
 *   3. Bookmark URL paths are NEVER returned. Same reasoning: bookmark
 *      URLs sometimes encode API keys.
 *   4. Output JSON (default --json mode) contains only: domain string,
 *      booleans, integer counts, integer timestamps, cookie NAME
 *      strings, score float.
 *
 * LOCK-HANDLING STRATEGY (the choice documented in the spec): TWO-PHASE.
 *   Phase 1: open with `?mode=ro&immutable=1` URI flag. SQLite trusts
 *           that no concurrent writer exists; if Chrome is running this
 *           is technically a lie, but the worst case is reading slightly
 *           stale rows (acceptable for metadata sampling — same
 *           contract as scripts/check_cookie_freshness.py).
 *   Phase 2: on `SQLITE_BUSY` or any open-time error, copy the DB file
 *           to a fresh `/tmp/unbrowse-auth-inventory-*` dir and open the
 *           copy. Tempdir cleanup runs in `finally`.
 *   Phase 3: if both fail, the per-source result reports the DB as
 *           `locked`. The handler still emits the AST for whatever
 *           sources DID open, with a `locked_sources` field surfacing
 *           the omission to the caller.
 *
 * Output shape:
 *   {
 *     "ok": true,
 *     "subcommand": "eval auth-inventory",
 *     "op_kind": "eval:auth_inventory",
 *     "platform": "darwin" | "linux" | "win32",
 *     "supported": true | false,
 *     "sources_scanned": ["chrome:/path", "firefox:/path", ...],
 *     "locked_sources": ["chrome:/path/Cookies", ...],
 *     "domain_count": number,
 *     "inventory": {
 *       "github.com": {
 *         "has_cookie": true,
 *         "fresh_cookie": true,
 *         "cookie_names": ["user_session", "logged_in"],
 *         "visit_count": 1247,
 *         "last_visit_unix": 1748534400,
 *         "bookmarked": true,
 *         "likely_logged_in_score": 0.95
 *       },
 *       ...
 *     }
 *   }
 *
 * Likely-logged-in heuristic (per memory project_v7_auth_inventory_ast.md):
 *   +0.6  domain has ≥1 cookie whose NAME matches the auth-pattern regex
 *         AND that cookie's expires_utc > now() + 1 hour
 *   +0.2  visit_count > 50
 *   +0.1  last_visit within 30 days
 *   +0.1  domain is bookmarked
 *   cap   0.95 (we never claim 1.0 without an actual auth attempt)
 */
import { existsSync } from "node:fs";
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless, type PostStatelessResult } from "../_stateless.js";
import {
  defaultChromeRoot,
  listChromeProfiles,
  readChromeProfile,
  type ChromeProfileResult,
} from "./auth-inventory-sources/chrome.js";
import {
  defaultFirefoxRoot,
  listFirefoxProfiles,
  readFirefoxProfile,
  type FirefoxProfileResult,
} from "./auth-inventory-sources/firefox.js";

/** Cookie names matching this regex contribute the +0.6 score lift. */
const AUTH_COOKIE_NAME_REGEX = /session|sess|auth|token|user|uid|login|jwt|sid|csrf|xsrf/i;

/**
 * Day-6 W7 stateless-eval witness — emit a sig-keyed `eval_read` audit row
 * whose body carries ONLY counts. NEVER the per-domain inventory (which is
 * fingerprintable) — only `{domainCount, scoredDomainCount, nonce}`. The
 * adapter signs over the whitelist and derives `cacheKey = sha256(sig)[:32]`.
 *
 * A2 invariant: every read crosses the firmament as a sig-keyed receipt.
 * A1 invariant: no local writes — the audit row lives in backend KV (or
 * surfaces a 503 binding_missing envelope; this handler NEVER stashes
 * domain data to disk under any path).
 *
 * Returns the `PostStatelessResult` so the handler can surface
 * `cacheKey` + `bindingMissing?` in its envelope. NEVER throws.
 */
export async function emitEvalReadAuditAuthInventory(args: {
  domainCount: number;
  scoredDomainCount: number;
}): Promise<PostStatelessResult> {
  return postStateless({
    namespace: "audit",
    route: "/v1/audit/eval-read",
    body: {
      variant: "eval-read",
      op_kind: "eval:auth_inventory",
      domainCount: args.domainCount,
      scoredDomainCount: args.scoredDomainCount,
    },
    signableFields: [
      "variant",
      "op_kind",
      "domainCount",
      "scoredDomainCount",
      "nonce",
    ],
  });
}

const ONE_HOUR_S = 3600;
const THIRTY_DAYS_S = 30 * 24 * 3600;
const SCORE_CAP = 0.95;

export interface DomainInventoryRow {
  readonly has_cookie: boolean;
  readonly fresh_cookie: boolean;
  readonly cookie_names: string[];
  readonly visit_count: number;
  readonly last_visit_unix: number;
  readonly bookmarked: boolean;
  readonly likely_logged_in_score: number;
}

export type AuthInventory = Record<string, DomainInventoryRow>;

/** Normalize a cookie host_key to a comparable hostname. */
function normalizeHostKey(host_key: string): string {
  let h = (host_key || "").toLowerCase();
  if (h.startsWith(".")) h = h.slice(1);
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

/**
 * Compose the per-domain AST from raw rows pulled by the source helpers.
 * Pure function — no I/O, easy to unit-test.
 */
export function composeInventory(args: {
  cookies: Array<{
    host_key: string;
    name: string;
    expires_utc_unix: number;
  }>;
  history: Array<{ hostname: string; visit_count: number; last_visit_unix: number }>;
  bookmarks: Array<{ hostname: string }>;
  nowUnix: number;
}): AuthInventory {
  const { cookies, history, bookmarks, nowUnix } = args;

  // Per-domain cookie aggregation.
  const cookieByDomain = new Map<
    string,
    { names: Set<string>; freshAuth: boolean }
  >();
  for (const c of cookies) {
    const host = normalizeHostKey(c.host_key);
    if (!host) continue;
    let entry = cookieByDomain.get(host);
    if (!entry) {
      entry = { names: new Set(), freshAuth: false };
      cookieByDomain.set(host, entry);
    }
    entry.names.add(c.name);
    if (
      AUTH_COOKIE_NAME_REGEX.test(c.name) &&
      c.expires_utc_unix > nowUnix + ONE_HOUR_S
    ) {
      entry.freshAuth = true;
    }
  }

  // Per-domain history aggregation (already aggregated by source helpers,
  // but multiple profiles may contribute — sum here).
  const histByDomain = new Map<
    string,
    { visit_count: number; last_visit_unix: number }
  >();
  for (const h of history) {
    const host = h.hostname;
    if (!host) continue;
    const prev = histByDomain.get(host);
    if (prev) {
      prev.visit_count += h.visit_count;
      if (h.last_visit_unix > prev.last_visit_unix) {
        prev.last_visit_unix = h.last_visit_unix;
      }
    } else {
      histByDomain.set(host, {
        visit_count: h.visit_count,
        last_visit_unix: h.last_visit_unix,
      });
    }
  }

  // Bookmarked set.
  const bookmarkedSet = new Set<string>();
  for (const b of bookmarks) {
    if (b.hostname) bookmarkedSet.add(b.hostname);
  }

  // Union of all observed domains.
  const allDomains = new Set<string>();
  for (const d of cookieByDomain.keys()) allDomains.add(d);
  for (const d of histByDomain.keys()) allDomains.add(d);
  for (const d of bookmarkedSet) allDomains.add(d);

  const inventory: Record<string, DomainInventoryRow> = {};
  for (const domain of allDomains) {
    const ck = cookieByDomain.get(domain);
    const hi = histByDomain.get(domain);
    const has_cookie = !!ck && ck.names.size > 0;
    const fresh_cookie = !!ck && ck.freshAuth;
    const cookie_names = ck ? [...ck.names].sort() : [];
    const visit_count = hi?.visit_count ?? 0;
    const last_visit_unix = hi?.last_visit_unix ?? 0;
    const bookmarked = bookmarkedSet.has(domain);

    let score = 0;
    if (fresh_cookie) score += 0.6;
    if (visit_count > 50) score += 0.2;
    if (last_visit_unix > 0 && nowUnix - last_visit_unix <= THIRTY_DAYS_S) {
      score += 0.1;
    }
    if (bookmarked) score += 0.1;
    if (score > SCORE_CAP) score = SCORE_CAP;
    // Round to 2dp for stable output.
    score = Math.round(score * 100) / 100;

    inventory[domain] = {
      has_cookie,
      fresh_cookie,
      cookie_names,
      visit_count,
      last_visit_unix,
      bookmarked,
      likely_logged_in_score: score,
    };
  }

  return inventory;
}

interface InventoryRunResult {
  readonly inventory: AuthInventory;
  readonly sources_scanned: string[];
  readonly locked_sources: string[];
}

/**
 * Run the full inventory walk. `chromeProfileOverride` (used by tests)
 * skips the platform-default walk and reads exactly that one profile.
 */
export async function runInventory(opts?: {
  chromeProfileOverride?: string;
  firefoxProfileOverride?: string;
  nowUnix?: number;
}): Promise<InventoryRunResult> {
  const nowUnix = opts?.nowUnix ?? Math.floor(Date.now() / 1000);
  const cookies: Array<{
    host_key: string;
    name: string;
    expires_utc_unix: number;
  }> = [];
  const history: Array<{
    hostname: string;
    visit_count: number;
    last_visit_unix: number;
  }> = [];
  const bookmarks: Array<{ hostname: string }> = [];
  const sources_scanned: string[] = [];
  const locked_sources: string[] = [];

  // Chrome.
  let chromeProfiles: string[] = [];
  if (opts?.chromeProfileOverride) {
    if (existsSync(opts.chromeProfileOverride)) {
      chromeProfiles = [opts.chromeProfileOverride];
    }
  } else {
    const root = defaultChromeRoot();
    if (root) chromeProfiles = await listChromeProfiles(root);
  }
  for (const profile of chromeProfiles) {
    const result: ChromeProfileResult = await readChromeProfile(profile);
    sources_scanned.push(`chrome:${profile}`);
    for (const c of result.cookies) {
      cookies.push({
        host_key: c.host_key,
        name: c.name,
        expires_utc_unix: c.expires_utc_unix,
      });
    }
    for (const h of result.history) history.push(h);
    for (const b of result.bookmarks) bookmarks.push(b);
    if (result.locks.cookies === "locked") {
      locked_sources.push(`chrome:${profile}/Cookies`);
    }
    if (result.locks.history === "locked") {
      locked_sources.push(`chrome:${profile}/History`);
    }
  }

  // Firefox.
  let firefoxProfiles: string[] = [];
  if (opts?.firefoxProfileOverride) {
    if (existsSync(opts.firefoxProfileOverride)) {
      firefoxProfiles = [opts.firefoxProfileOverride];
    }
  } else {
    const root = defaultFirefoxRoot();
    if (root) firefoxProfiles = await listFirefoxProfiles(root);
  }
  for (const profile of firefoxProfiles) {
    const result: FirefoxProfileResult = await readFirefoxProfile(profile);
    sources_scanned.push(`firefox:${profile}`);
    for (const c of result.cookies) {
      cookies.push({
        host_key: c.host_key,
        name: c.name,
        expires_utc_unix: c.expires_utc_unix,
      });
    }
    for (const h of result.history) history.push(h);
    for (const b of result.bookmarks) bookmarks.push(b);
    if (result.locks.cookies === "locked") {
      locked_sources.push(`firefox:${profile}/cookies.sqlite`);
    }
    if (result.locks.places === "locked") {
      locked_sources.push(`firefox:${profile}/places.sqlite`);
    }
  }

  const inventory = composeInventory({ cookies, history, bookmarks, nowUnix });
  return { inventory, sources_scanned, locked_sources };
}

/**
 * Truncate inventory to the top-N domains by score, descending.
 * Ties broken by visit_count desc, then domain string asc.
 */
export function topN(inventory: AuthInventory, n: number): AuthInventory {
  const rows = Object.entries(inventory);
  rows.sort((a, b) => {
    if (b[1].likely_logged_in_score !== a[1].likely_logged_in_score) {
      return b[1].likely_logged_in_score - a[1].likely_logged_in_score;
    }
    if (b[1].visit_count !== a[1].visit_count) {
      return b[1].visit_count - a[1].visit_count;
    }
    return a[0].localeCompare(b[0]);
  });
  const trimmed: AuthInventory = {};
  for (const [k, v] of rows.slice(0, n)) trimmed[k] = v;
  return trimmed;
}

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  const meta = lookupKindMap("eval", "auth-inventory")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval auth-inventory",
      {
        summary:
          "Per-domain AST of what the user can already authenticate against — from local browser cookies (metadata only), history (hostnames only), bookmarks (hostnames only).",
        usage:
          "unbrowse eval auth-inventory [--limit N] [--json] [--chrome-profile <path>] [--firefox-profile <path>]",
        flags: [
          {
            name: "--limit",
            description: "Top-N domains by score (default 100).",
            value_expected: true,
          },
          {
            name: "--chrome-profile",
            description: "Test override: scan exactly this Chrome profile directory.",
            value_expected: true,
          },
          {
            name: "--firefox-profile",
            description: "Test override: scan exactly this Firefox profile directory.",
            value_expected: true,
          },
          { name: "--no-json", description: "Compact `domain: score check` lines." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const platform = process.platform;
  const supported = platform === "darwin" || platform === "linux";

  // Honest skip on Windows.
  if (!supported) {
    emit(
      {
        ok: true,
        subcommand: "eval auth-inventory",
        op_kind: meta.op_kind,
        platform,
        supported: false,
        skipped_reason:
          "auth-inventory is implemented for darwin + linux only; windows browser profile paths are out of scope.",
        domain_count: 0,
        inventory: {},
      },
      opts,
    );
    process.exit(0);
  }

  const limit =
    typeof parsed.flags.limit === "string"
      ? Number.parseInt(parsed.flags.limit, 10)
      : 100;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  const chromeProfileOverride =
    typeof parsed.flags["chrome-profile"] === "string"
      ? (parsed.flags["chrome-profile"] as string)
      : undefined;
  const firefoxProfileOverride =
    typeof parsed.flags["firefox-profile"] === "string"
      ? (parsed.flags["firefox-profile"] as string)
      : undefined;
  const noJson = parsed.flags["no-json"] === true;

  try {
    const result = await runInventory({
      chromeProfileOverride,
      firefoxProfileOverride,
    });
    const trimmed = topN(result.inventory, safeLimit);
    const domainCount = Object.keys(result.inventory).length;
    const scoredDomainCount = Object.values(result.inventory).filter(
      (r) => r.likely_logged_in_score > 0,
    ).length;

    // Day-6 W7 — fire the eval_read audit receipt BEFORE emitting the
    // AST. The audit row carries ONLY counts; the full domain list
    // never crosses the firmament. The receipt's cacheKey surfaces in
    // the emitted envelope as `_receipt_cache_key`.
    const post = await emitEvalReadAuditAuthInventory({
      domainCount,
      scoredDomainCount,
    });
    const receiptCacheKey = post.cacheKey || undefined;
    const receiptBindingMissing = post.bindingMissing;
    const receiptHttpStatus = post.httpStatus;

    if (noJson) {
      // Sort by score desc for the human-readable mode.
      const sorted = Object.entries(trimmed).sort(
        (a, b) => b[1].likely_logged_in_score - a[1].likely_logged_in_score,
      );
      for (const [domain, row] of sorted) {
        const mark = row.fresh_cookie ? "✓" : " ";
        process.stdout.write(
          `${domain}: ${row.likely_logged_in_score.toFixed(2)} ${mark}\n`,
        );
      }
    } else {
      emit(
        {
          ok: true,
          subcommand: "eval auth-inventory",
          op_kind: meta.op_kind,
          platform,
          supported: true,
          sources_scanned: result.sources_scanned,
          locked_sources: result.locked_sources,
          domain_count: Object.keys(trimmed).length,
          inventory: trimmed,
          _receipt_cache_key: receiptCacheKey ?? null,
          _receipt_binding_missing: receiptBindingMissing ?? null,
          _receipt_http_status: receiptHttpStatus ?? null,
        },
        opts,
      );
    }
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
