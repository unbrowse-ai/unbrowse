/**
 * Browser fallback — the index is an accelerator, not a dependency.
 *
 * The intended architecture is: ask the index; if it has nothing (or what it
 * gave back does not satisfy the intent), OPEN THE BROWSER, learn the route, and
 * index it so the NEXT call is a fast index hit. Search is the fast path, the
 * browser is the floor.
 *
 * That floor was missing on the shipped path. `escalate-on-miss.ts` implements
 * exactly this idea but is wired only into the v7 `eval resolve` dev surface;
 * the orchestrator — which every shipped call goes through — instead treated a
 * failed verdict as terminal.
 *
 * Observed live against staging (whose index returns 0 results for every query):
 *   search -> 0 results
 *   -> direct-document GUESSES a page (quotes.toscrape.com/scroll -> /search.aspx)
 *   -> the guess is the wrong shape
 *   -> response_shape_mismatch, task_ok:false, and it STOPS.
 * A browser was never opened, even though opening one is precisely what would
 * have answered the question — and would have populated the index for next time.
 *
 * This module is the pure decision only. It performs no I/O so the policy can be
 * tested exhaustively; the caller owns the one expensive side effect.
 */

import { isOriginUnreachableError } from "../values/origin-health.js";
import { hasAuthArtifact } from "../auth/artifact-bridge.js";

/** The verdict shape this decision reads (a subset of OrchestratorResult). */
export interface FallbackJudgment {
  trace: { success?: boolean; error?: string };
  result?: unknown;
  timing?: { browser_opened?: boolean };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

/**
 * Is this failure one a browser cannot fix because the caller lacks a session?
 *
 * Recognised by the SHAPE the orchestrator's own truth gates emit — `blocker:
 * "auth"`, `auth_required`, `auth_ok` (see `enforceIntentResultTruth`) — rather
 * than by an enumerated list of auth error names. Per the repo's standing rule,
 * a new auth-shaped failure is then excluded for free, with no new list entry.
 */
function authBlocked(result: unknown): boolean {
  const r = asRecord(result);
  if (!r) return false;
  return r.blocker === "auth" || r.auth_required === true || r.auth_ok === false;
}

/** Payment is the other wall a browser cannot climb — retrying just costs again. */
function paymentBlocked(result: unknown, error: string): boolean {
  if (error === "payment_required") return true;
  const r = asRecord(result);
  return r?.payment_status === "payment_required";
}

export interface FallbackDecision {
  escalate: boolean;
  /** Why — recorded on the trace so a skipped escalation is legible too. */
  reason: string;
}

/**
 * Pages a rescue already looked at and found nothing on.
 *
 * Measured: a fallback against a static page with no API calls opens Chrome,
 * captures for ~14s, finds 0 requests, and loses — and without this, it pays
 * that again on every single call, forever. Remembering the barren page turns a
 * permanent 14s tax into a one-time one.
 *
 * TTL-bounded rather than permanent, because "this page has no API" is a fact
 * about today: a site can ship an API next week, and a permanent negative cache
 * would make us blind to it. Short enough to stay responsive to that, long
 * enough that a burst of calls pays once.
 */
const barrenPages = new Map<string, number>();
export const BARREN_PAGE_TTL_MS = 30 * 60_000;

/** Key on intent+url: the same page can be barren for one intent and rich for another. */
const barrenKey = (intent: string, url: string) => `${intent.trim().toLowerCase()} ${url}`;

/** Record that a browser looked at this page for this intent and learned nothing. */
export function markBarrenPage(intent: string, url: string, now = Date.now()): void {
  barrenPages.set(barrenKey(intent, url), now + BARREN_PAGE_TTL_MS);
}

/** Has a browser recently looked at this page for this intent and found nothing? */
export function isBarrenPage(intent: string, url: string, now = Date.now()): boolean {
  const expires = barrenPages.get(barrenKey(intent, url));
  if (expires === undefined) return false;
  if (expires <= now) {
    barrenPages.delete(barrenKey(intent, url));
    return false;
  }
  return true;
}

/** Test seam — the map is module state, so suites must be able to reset it. */
export function _resetBarrenPages(): void {
  barrenPages.clear();
}

/**
 * Serialize the barren set so a CALLER can persist it.
 *
 * This module stays pure — no fs, no clock beyond an injectable `now` — because
 * the permutation matrix exhausts it as a pure function. Persistence is the
 * orchestrator's job; this pair is the seam between them.
 *
 * It exists because the in-memory Map was silently useless to the CLI. The CLI
 * runs ONE PROCESS PER CALL, so the map was always empty at startup and the
 * ~14s barren capture was re-paid on every invocation. The measured "17.9s ->
 * 0.9s" was taken inside one long-lived process — true for the server and MCP
 * shapes, false for the CLI, which is how most people use it.
 */
export function exportBarrenPages(now = Date.now()): Array<[string, number]> {
  return [...barrenPages.entries()].filter(([, expires]) => expires > now);
}

/** Load a previously persisted barren set, dropping anything already expired. */
export function hydrateBarrenPages(entries: Array<[string, number]>, now = Date.now()): void {
  if (!Array.isArray(entries)) return;
  for (const row of entries) {
    // Guard BEFORE destructuring: this reads a file on disk, and a truncated or
    // hand-edited cache yields rows like `null`. Destructuring one of those threw,
    // which discarded every good entry alongside the bad one.
    if (!Array.isArray(row)) continue;
    const [key, expires] = row;
    if (typeof key === "string" && typeof expires === "number" && expires > now) {
      barrenPages.set(key, expires);
    }
  }
}

/**
 * Should this failed verdict be retried by opening a browser?
 *
 * The default is YES, because "we returned a failure without ever looking at the
 * page" is the exact situation the browser exists for. That default is what
 * makes this general: a failure mode nobody has named yet still gets the browser
 * floor, with no allowlist to extend.
 *
 * It is held cheap by four structural guards rather than by a narrow trigger:
 *   1. this is the top-level call, not the exa->candidate walk re-entering
 *      `resolveAndExecute` (otherwise one user call could open two browsers),
 *   2. the verdict actually failed (a success is never re-run),
 *   3. no browser was opened already (this is a floor, not a loop),
 *   4. there is a URL to descend into,
 * and by excluding the three walls a browser genuinely cannot climb: a session
 * the caller does not have, a payment, and an origin that never answered.
 *
 * That third one was missing, and it cost a full browser launch every time. A
 * site that ANSWERS with a 403 or a challenge may yield to a different client,
 * so the browser floor is right. An origin that never answered — no DNS record,
 * connection refused, CDN cannot reach its backend — has nothing behind it for
 * any client to reach. Measured: `swapi.dev` (NXDOMAIN) escalated to a browser
 * that hit the identical resolver failure.
 */
export function shouldFallbackToBrowser(
  judged: FallbackJudgment,
  context?: { url?: string },
  walkDepth?: number,
  intent?: string,
): FallbackDecision {
  // The pointer pipe re-enters the PUBLIC resolveAndExecute for each candidate.
  // Let the inner miss bubble up and let the outer call decide once, with the
  // user's own URL, rather than escalating per candidate.
  if ((walkDepth ?? 0) > 0) return { escalate: false, reason: "inner_walk_defers_to_outer" };

  if (judged.trace?.success !== false) return { escalate: false, reason: "verdict_succeeded" };

  // Already looked at the page — a second look returns the same answer, and the
  // absence of this guard is how a fallback becomes an infinite ladder.
  if (judged.timing?.browser_opened === true) {
    return { escalate: false, reason: "browser_already_opened" };
  }

  const url = context?.url?.trim();
  if (!url) return { escalate: false, reason: "no_url_to_descend_into" };

  // A browser already looked at this exact page for this intent and found
  // nothing. Looking again costs a full capture to reach the same answer.
  if (intent !== undefined && isBarrenPage(intent, url)) {
    return { escalate: false, reason: "page_known_barren" };
  }

  const error = String(judged.trace?.error ?? "");
  if (authBlocked(judged.result)) {
    const domain = (() => { try { return new URL(context?.url ?? "").hostname.replace(/^www\./, ""); } catch { return ""; } })();
    if (domain && hasAuthArtifact(domain)) {
      return { escalate: true, reason: `auth_blocked_but_artifact_present:${domain}` };
    }
    return { escalate: false, reason: "auth_blocked_browser_cannot_fix" };
  }
  if (paymentBlocked(judged.result, error)) {
    return { escalate: false, reason: "payment_blocked_browser_cannot_fix" };
  }
  // The origin never answered. A browser resolves the same DNS and opens the
  // same socket, so it buys a second identical failure at ~14s a go.
  if (isOriginUnreachableError(error)) {
    return { escalate: false, reason: "origin_unreachable_browser_cannot_fix" };
  }

  return { escalate: true, reason: `browser_fallback:${error || "unnamed_failure"}` };
}

/**
 * Did the browser attempt actually improve on the verdict it was meant to fix?
 * Used so a fallback that failed too reports the ORIGINAL error rather than
 * replacing a precise diagnosis with a vaguer one from the retry.
 */
export function fallbackImproved(
  original: FallbackJudgment,
  retried: FallbackJudgment,
): boolean {
  return retried.trace?.success === true;
}

/**
 * Carry a browser observation from the fallback attempt onto the verdict we
 * actually return.
 *
 * Measured on a static page with no API calls: the rescue opened Chrome,
 * captured for 14s, found 0 requests, and lost — so the original verdict is
 * returned, and its `browser_opened` is false even though a browser did open.
 * Returning that unchanged would understate what the call actually did.
 */
export function carryBrowserOpened<T extends FallbackJudgment>(output: T, attempt: FallbackJudgment): T {
  if (attempt.timing?.browser_opened !== true) return output;
  return { ...output, timing: { ...output.timing, browser_opened: true } };
}
