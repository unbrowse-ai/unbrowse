// Pre-resolve auth-gate primitive (Day-6 W1).
//
// Purpose: stop the resolve probe-fallback from synthesizing Exa
// answers for intents that are obviously personal (e.g. "see my github
// notifications") against known-auth-gated hosts when the local
// machine has no fresh cookie. The pre-Day-6 path would budget_race
// → probe winner (HEAD-200 on the login redirect) → synthesize an
// Exa answer carrying GitHub Docs *about* notifications — a D15
// fake-green violation: the response says success:true while the data
// describes a generic doc page, not the caller's actual data.
//
// Three structural primitives gate the short-circuit. If ALL three
// hold, the orchestrator skips the race entirely and returns an
// auth_required envelope so the agent can call unbrowse_auth_capture
// before retrying.
//
// 1. Personal pronoun or explicit auth-shaped task in the intent
//    (case-insensitive, word boundary).
// 2. Host is in the known-auth-gated set (data-driven const array,
//    NOT switch-cased, easy to extend, audit grep
//    `host === "<lit>"` MUST stay empty).
// 3. No fresh cookie for the host in the local Chrome/Firefox SQLite
//    cookie store (consulted via scripts/check_cookie_freshness.py;
//    metadata only — values are never decrypted).
//
// This is NOT a per-domain shortcut: the auth-gated host set is a
// piece of data, the check is the same `arr.includes(...)` for every
// host. Adding a host means appending to the array, never editing
// branching logic.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hosts that almost always require an authenticated session for the
 * user's personal content. Keep ≤ 10 entries; extend only when a new
 * site materially benefits from the pre-resolve gate. Match is
 * suffix-based so `mail.google.com` matches `google.com` etc.
 */
export const AUTH_GATED_HOSTS: ReadonlyArray<string> = [
  "github.com",
  "gmail.com",
  "google.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "reddit.com",
  "instagram.com",
  "facebook.com",
  "notion.so",
];

const PERSONAL_PRONOUN_RE = /\b(my|me|mine|our|ours|i)\b/i;
const AUTH_SHAPED_INTENT_RE = /\b(auth|authenticate|authenticated|login|logged in|sign in|signin|account|session|mail|inbox|console|dashboard|api key|credentials?)\b/i;

export function hasPersonalPronoun(intent: string | null | undefined): boolean {
  if (!intent) return false;
  return PERSONAL_PRONOUN_RE.test(intent);
}

export function hasAuthShapedIntent(intent: string | null | undefined): boolean {
  if (!intent) return false;
  return AUTH_SHAPED_INTENT_RE.test(intent);
}

export function isAuthGatedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return AUTH_GATED_HOSTS.some((gated) => h === gated || h.endsWith(`.${gated}`));
}

export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie-freshness probe (delegates to scripts/check_cookie_freshness.py)
// ---------------------------------------------------------------------------

export type CookieFreshness = {
  fresh: boolean;
  source: "chrome" | "firefox" | "browser" | "none" | "locked" | "error";
  reason: string;
};

/**
 * Multi-browser harvest fallback (2026-06-20).
 *
 * `check_cookie_freshness.py` only inspects Chrome + Firefox. A user whose live
 * session lives in any OTHER daily-driver browser (Dia, Arc, Brave, Edge, Vivaldi,
 * Opera, Chromium) would read as source="none" and get bounced to an interactive
 * auth-capture — even though the runtime can already harvest that session
 * (scanAllBrowserSessions decrypts every Chromium browser's keychain store).
 *
 * Pure: given the python probe result + a session scanner, upgrade a "none" verdict
 * to fresh=true when the daily-driver browser holds a session-grade cookie set.
 * `fresh`/`locked`/`error` verdicts pass through unchanged (don't override a real hit
 * or a "freshness unknown, attempt anyway" signal).
 */
export function applyHarvestFallback(
  base: CookieFreshness,
  domain: string,
  scan: (domain: string) => { browser: string; sessionCookies: number } | null,
): CookieFreshness {
  if (base.source !== "none") return base;
  const session = scan(domain);
  if (session && session.sessionCookies > 0) {
    return {
      fresh: true,
      source: "browser",
      reason: `live session harvested from ${session.browser} (${session.sessionCookies} session cookies)`,
    };
  }
  return base;
}

/** Locate scripts/check_cookie_freshness.py from this module's location.
 *  Walks up from src/auth/ to repo root; safe to run from either ESM or
 *  CommonJS contexts. */
function findCookieFreshnessScript(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/auth/pre-resolve-gate.{ts,js} → ../../scripts/check_cookie_freshness.py
    const candidate = join(here, "..", "..", "scripts", "check_cookie_freshness.py");
    if (existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url unavailable
  }
  // Fallback: CWD-relative
  const cwdCandidate = join(process.cwd(), "scripts", "check_cookie_freshness.py");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

/** Inspect local browser cookie metadata for `host`. Never decrypts
 *  cookie values. SQLite lock → source="locked" → treated as
 *  "freshness unknown, do NOT skip the race" per CLAUDE.md anti-skip
 *  rule. Errors return source="error" with fresh=false. */
export function hasFreshCookieForHost(
  host: string,
  opts?: {
    script_path?: string;
    python_bin?: string;
    timeout_ms?: number;
    /** Injectable multi-browser session scanner (default: findBestBrowserSession). */
    session_scan?: (domain: string) => { browser: string; sessionCookies: number } | null;
  },
): CookieFreshness {
  // Default scanner sweeps every Chromium-family browser + Firefox and decrypts
  // their cookie stores (Dia/Arc/Brave/Edge/... not just Chrome). Lazy require so
  // callers that pass their own scanner never load the cookie decryptor.
  const scan =
    opts?.session_scan ??
    ((domain: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { findBestBrowserSession } = require("./browser-cookies.js") as typeof import("./browser-cookies.js");
        const best = findBestBrowserSession(domain);
        return best ? { browser: best.browser, sessionCookies: best.sessionCookies } : null;
      } catch {
        return null;
      }
    });

  const scriptPath = opts?.script_path ?? findCookieFreshnessScript();
  if (!scriptPath) {
    // No python probe — still try the multi-browser harvest before giving up.
    return applyHarvestFallback(
      { fresh: false, source: "none", reason: "check_cookie_freshness.py not found" },
      host,
      scan,
    );
  }
  const pythonBin = opts?.python_bin ?? "python3";
  const timeout = opts?.timeout_ms ?? 3000;
  try {
    const out = execFileSync(pythonBin, [scriptPath, host], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const row = JSON.parse(out) as {
      fresh?: boolean;
      source?: string;
      reason?: string;
    };
    const base: CookieFreshness = {
      fresh: row.fresh === true,
      source: (row.source as CookieFreshness["source"]) ?? "error",
      reason: row.reason ?? "",
    };
    // Chrome/Firefox said "none" — sweep the user's other daily-driver browsers
    // before bouncing them to an interactive login.
    return applyHarvestFallback(base, host, scan);
  } catch (err) {
    // Python probe unavailable/failed. Still give the multi-browser harvest a
    // chance: a definite session beats an "unknown". No session -> keep "error"
    // (the anti-skip rule lets the caller attempt rather than bounce).
    const upgraded = applyHarvestFallback(
      { fresh: false, source: "none", reason: "" },
      host,
      scan,
    );
    if (upgraded.fresh) return upgraded;
    return {
      fresh: false,
      source: "error",
      reason: `cookie freshness probe failed: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The composite gate
// ---------------------------------------------------------------------------

export type PreResolveAuthGateDecision =
  | { gate: "pass" } // not personal / not auth-gated / has cookie / locked-DB unknown
  | {
      gate: "auth_required";
      host: string;
      reason: string;
      cookie_source: CookieFreshness["source"];
    };

/**
 * Decide whether to short-circuit resolve with an auth_required
 * envelope BEFORE the budget_race fires. The caller wraps the
 * decision in the actual envelope shape (status, next_step,
 * suggested_commands).
 *
 * Pass when ANY of the three conditions fails — keeps the gate
 * narrow and structural.
 *
 * The cookie probe is bypassable for tests via opts.cookie_probe.
 */
export function decidePreResolveAuthGate(
  intent: string | null | undefined,
  url: string | null | undefined,
  opts?: {
    cookie_probe?: (host: string) => CookieFreshness;
  },
): PreResolveAuthGateDecision {
  if (!hasPersonalPronoun(intent) && !hasAuthShapedIntent(intent)) return { gate: "pass" };
  const host = hostFromUrl(url);
  if (!host) return { gate: "pass" };
  if (!isAuthGatedHost(host)) return { gate: "pass" };
  const probe = opts?.cookie_probe ?? ((h: string) => hasFreshCookieForHost(h));
  const freshness = probe(host);
  // Locked Chrome → unknown freshness → caller should attempt (do NOT
  // skip), per CLAUDE.md cookie-freshness rule. Same for error.
  if (freshness.source === "locked" || freshness.source === "error") {
    return { gate: "pass" };
  }
  if (freshness.fresh) return { gate: "pass" };
  return {
    gate: "auth_required",
    host,
    reason: `auth-shaped intent + auth-gated host + no fresh cookie (source=${freshness.source})`,
    cookie_source: freshness.source,
  };
}
