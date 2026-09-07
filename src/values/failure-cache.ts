/**
 * failure-cache — the NEGATIVE half of cached-resolution: a content-addressed record
 * of endpoints / egress-rungs that FAILED, so the resolver fails-fast on a known-dead
 * path instead of re-paying its cost. The inverse of "capture once, replay everywhere":
 * "fail once, skip-fast until the cooldown expires." It is a resolution LAYER — consulted
 * before an attempt the way `peekResolution` is consulted for the positive cache.
 *
 * Design (grounded in the route-ranking freshness model arXiv:2604.00694 §6.3 + the
 * maintenance-network route-health thesis):
 *  - TTL by FAILURE CLASS, never flat. Failures have different recovery half-lives:
 *      structural (provider-dead / 404 / NXDOMAIN / NO_AVAILABLE_KEYS) → ~24h
 *      antibot    (403 / captcha / JS-challenge) → ~2h, egress-dependent
 *      transient  (503 / 429 / timeout)          → ~10min
 *  - Key is content-addressed INCLUDING the egress mode, so switching
 *    iproyal→proxykingdom→direct re-probes instead of inheriting a stale "blocked".
 *  - It is a HINT, never a permanent blacklist: the entry only suppresses until the
 *    class TTL elapses; the first attempt after expiry re-tests (no fabricated red).
 *  - Disabled (pass-through) when UNBROWSE_STATELESS=1 — the stateless binary writes
 *    nothing. All I/O is best-effort and never throws.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";

export type FailureClass = "structural" | "antibot" | "transient";

/** Recovery half-life per class. structural recovers slowly; transient fast. */
export const FAILURE_TTL_MS: Record<FailureClass, number> = {
  structural: 24 * 60 * 60_000,
  antibot: 2 * 60 * 60_000,
  transient: 10 * 60_000,
};

export function failureCacheDir(): string {
  return join(homedir(), ".unbrowse", "failure-cache");
}

function enabled(): boolean {
  return process.env.UNBROWSE_STATELESS !== "1" && process.env.UNBROWSE_FAILURE_CACHE !== "0";
}

/**
 * Classify an outcome into a failure class, or null when it is NOT a failure.
 * Reads HTTP status + a response/error body. Order matters: structural before antibot
 * before transient (a 404 is structural even if the body mentions "challenge").
 */
export function classifyFailure(input: { status?: number; body?: string; errorCode?: string }): FailureClass | null {
  const { status } = input;
  const b = `${input.body ?? ""} ${input.errorCode ?? ""}`.toLowerCase();
  if (/no_available_keys|no available keys|nxdomain|enotfound|name_not_resolved|err_name_not_resolved/.test(b)) return "structural";
  if (status === 404 || status === 410) return "structural";
  if (status === 403 || /just a moment|datadome|perimeterx|akamai|incapsula|verify you are human|are you a robot|captcha|challenge-platform|cf-browser-verification/.test(b)) return "antibot";
  if (status === 503 || status === 429 || status === 408 || status === 504 || /timeout|timed out|econnreset|temporarily unavailable|cli_timeout/.test(b)) return "transient";
  if (typeof status === "number" && status >= 500) return "transient";
  return null;
}

/**
 * Content-addressed key for a target + egress mode. Path digits are templatized
 * (/jobs/12345 → /jobs/*) so per-item URLs collapse to one route key. egress is part
 * of the key so a proxy change re-probes rather than inheriting a stale verdict.
 */
export function failureKey(target: string, egress = "default"): string {
  let host = target;
  let path = "";
  try {
    const u = new URL(target);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname.replace(/\d+/g, "*");
  } catch { /* non-URL target (a proxy host etc.) — hash verbatim */ }
  return createHash("sha256").update(`${host}|${path}|${egress}`).digest("hex").slice(0, 24);
}

interface FailureRow { k: string; cls: FailureClass; at: number; target: string }

function ledgerPath(dir: string): string { return join(dir, "failures.jsonl"); }

/** Record a failure for target+egress (best-effort, never throws). */
export function recordFailure(target: string, cls: FailureClass, egress = "default", dir?: string, now?: number): void {
  if (!enabled()) return;
  try {
    const root = dir ?? failureCacheDir();
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const row: FailureRow = { k: failureKey(target, egress), cls, at: now ?? Date.now(), target: target.slice(0, 120) };
    appendFileSync(ledgerPath(root), JSON.stringify(row) + "\n");
  } catch { /* best-effort */ }
}

/** Convenience: classify an outcome and record it if it IS a failure. Returns the class. */
export function recordOutcome(
  target: string,
  outcome: { status?: number; body?: string; errorCode?: string },
  egress = "default",
  dir?: string,
  now?: number,
): FailureClass | null {
  const cls = classifyFailure(outcome);
  if (cls) recordFailure(target, cls, egress, dir, now);
  return cls;
}

/**
 * Peek: is target+egress inside a FRESH failure cooldown? Returns the class when the path
 * should be SKIPPED (fail-fast to the next rung), else null (re-probe). Most-recent matching
 * row wins; an expired row returns null so the next attempt re-tests. Pure fs, never throws.
 */
export function peekFailure(target: string, egress = "default", dir?: string, now?: number): FailureClass | null {
  if (!enabled()) return null;
  try {
    const root = dir ?? failureCacheDir();
    const p = ledgerPath(root);
    if (!existsSync(p)) return null;
    const key = failureKey(target, egress);
    const t = now ?? Date.now();
    let latest: FailureRow | null = null;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as FailureRow;
        if (r.k === key && (!latest || r.at > latest.at)) latest = r;
      } catch { /* skip malformed */ }
    }
    if (!latest) return null;
    if (t - latest.at > FAILURE_TTL_MS[latest.cls]) return null; // cooldown expired → re-probe
    return latest.cls;
  } catch {
    return null;
  }
}
