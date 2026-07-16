/**
 * coverage-check — the "is this domain already covered?" gate for `act capture`.
 *
 * Long-term fix for a real gap: `cmdCapture` (`src/cli.ts`) used to POST to
 * `/v1/capture` unconditionally, with no check against either this machine's
 * local skill-cache or the shared marketplace first. In the documented flow
 * (SKILL.md: "on a genuine MISS... do ONE escalation: act capture") that gap
 * never bites, because a real miss from `eval resolve` already implies both
 * were checked — but nothing enforced that ordering in code. A caller that
 * reaches for `act capture` directly redoes a real browser capture even when
 * the exact route already sits in the shared graph, free, sub-second.
 *
 * This module is the single source of truth for that check, reusing the
 * SAME cascade `eval resolve --domain` already uses (local cache, then the
 * marketplace) rather than duplicating it — `localShortlistForDomain` is
 * literally imported, not reimplemented. It deliberately does NOT reuse
 * resolve's on-chain / audit-trail / signed-nonce-receipt machinery: those
 * are billable-read accounting concerns for a user-facing resolve call, not
 * needed for an internal pre-check gate.
 */
import { localShortlistForDomain } from "../cli-v7/eval/resolve.js";
import { ensureUsableKey } from "../client/index.js";
import { mergedAuthHeaders } from "../lib/wallet-auth-headers.js";
import { DEFAULT_BACKEND_URL } from "../version.js";

export interface DomainCoverageResult {
  covered: boolean;
  source: "local_cache" | "marketplace" | "none";
  skill_id?: string;
  endpoint_count?: number;
}

const MARKETPLACE_CHECK_TIMEOUT_MS = 8000;

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

/**
 * Check the shared commons for existing coverage of `domain` before an
 * expensive browser capture. Local cache first (free, instant), marketplace
 * second (one lightweight network round-trip). Fails OPEN on any marketplace
 * error — a network hiccup here must never block a real capture, since the
 * whole point is to avoid wasted work, not add a hard dependency.
 */
export async function checkDomainCoverage(domain: string): Promise<DomainCoverageResult> {
  const local = localShortlistForDomain(domain, 1);
  if (local.length > 0) {
    return {
      covered: true,
      source: "local_cache",
      skill_id: typeof local[0].skill_id === "string" ? local[0].skill_id : undefined,
      endpoint_count: local.length,
    };
  }

  try {
    const base = resolveApiBase().replace(/\/$/, "");
    const walletAuth = await mergedAuthHeaders();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...walletAuth,
    };
    const keyResult = await ensureUsableKey();
    if (keyResult.key && keyResult.key !== "local-only") {
      headers["authorization"] = `Bearer ${keyResult.key}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MARKETPLACE_CHECK_TIMEOUT_MS);
    let body: { domain_results?: unknown[] } = {};
    let ok = false;
    try {
      const r = await fetch(`${base}/v1/search/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ intent: "capture pre-check", domain, domain_k: 1, global_k: 0 }),
        signal: ctrl.signal,
      });
      ok = r.ok;
      body = ok ? ((await r.json().catch(() => ({}))) as { domain_results?: unknown[] }) : {};
    } finally {
      clearTimeout(timer);
    }

    const domainResults = Array.isArray(body.domain_results) ? body.domain_results : [];
    if (ok && domainResults.length > 0) {
      const first = domainResults[0] as Record<string, unknown>;
      return {
        covered: true,
        source: "marketplace",
        skill_id: typeof first.skill_id === "string" ? first.skill_id : undefined,
        endpoint_count: domainResults.length,
      };
    }
  } catch {
    // Network/auth error on the pre-check: fail open (treat as uncovered) so
    // capture still proceeds. The pre-check is an optimization, not a gate
    // that should ever block a real capture on its own failure.
  }

  return { covered: false, source: "none" };
}
