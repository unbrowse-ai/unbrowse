/**
 * onchain — three-tier route lookup decision, pure functions.
 *
 * Mirrors the contract at packages/sdk-v2/CONTRACT.md. The SDK computes a
 * decision client-side and sends it as a hint to the worker; the worker
 * re-derives independently (defense in depth — the worker is the truth-root
 * for what actually happens, the SDK's decision is advisory).
 *
 * Tier 1: route cache ledger (contracts.jsonl, hash-chained).
 * Tier 2: chrome KV-chain preference bias (bookmarkDomains / recentDomains).
 * Tier 3: Solana IQ attestation (IqClient.readRows) — slowest, last resort.
 *
 * Statelessness invariants (mirrors src/chrome/CONTRACT.md):
 *   - No module-level state.
 *   - All functions are pure: same inputs → same outputs.
 *   - The functions read inputs (route rows, preference sets); they do not
 *     write to the ledger, the KV-chain, or Solana.
 *   - Commitments (sha256) are passed through, never the response body or
 *     sealed ciphertext (pointer-over-payload).
 */

export interface RouteCacheRow {
  endpoint_id: string;
  intent: string;
  context_url: string;
  /** SHA-256 pointer to the captured route metadata — never the body. */
  commitment: string;
  /** Unix ms of the capture event. */
  captured_at: number;
  /** Initial route score (e.g. from cardinality / signal ranking). */
  score: number;
}

export interface PreferenceBias {
  strong: Set<string>;  // bookmarked eTLD+1
  weak: Set<string>;    // recently-visited eTLD+1
}

export interface IqAttestationRow {
  commitment: string;
  /** Unix ms of the on-chain attestation. */
  attested_at: number;
  /** True when the attestation is signed by a known contract child. */
  signed_by_child: boolean;
}

export type OnChainAction =
  | "replay"
  | "live_fetch_direct"
  | "live_fetch_iproyal"
  | "live_fetch_with_captcha";

export interface OnChainRouteDecision {
  action: OnChainAction;
  endpoint_id?: string;
  commitment?: string;
  attested_on_chain?: boolean;
  preference_bias?: "strong" | "weak" | null;
  reason: string;
}

/**
 * Tier-1 lookup: scan the route cache for a row whose intent + context_url
 * match the inbound request and whose captured_at is within the staleness
 * window. Returns the freshest match, or null.
 *
 * The `now` parameter is injected so this stays pure-time — same inputs, same
 * output, no Date.now() inside the function (testable without time mocking).
 */
export function tier1RouteCacheLookup(
  rows: RouteCacheRow[],
  intent: string,
  context_url: string,
  stale_after_ms: number,
  now: number,
): RouteCacheRow | null {
  let best: RouteCacheRow | null = null;
  for (const row of rows) {
    if (row.intent !== intent) continue;
    if (row.context_url !== context_url) continue;
    const age = now - row.captured_at;
    if (age < 0 || age > stale_after_ms) continue;
    if (!best || row.captured_at > best.captured_at) best = row;
  }
  return best;
}

/**
 * Tier-2 lookup: derive the eTLD+1 preference bias from the inbound URL.
 * Returns "strong" if bookmarked, "weak" if recently visited, null otherwise.
 *
 * Side-effect-free. Reads the PreferenceBias sets; does not mutate them.
 */
export function tier2PreferenceBias(
  url: string,
  prefs: PreferenceBias,
): "strong" | "weak" | null {
  const etld = etldPlusOne(url);
  if (!etld) return null;
  if (prefs.strong.has(etld)) return "strong";
  if (prefs.weak.has(etld)) return "weak";
  return null;
}

/**
 * Tier-3 lookup: scan Solana IQ attestation rows for one whose commitment
 * matches a tier-1 cache hit. Returns the attestation row or null. Slowest
 * tier — only call when tiers 1+2 produced no decision.
 */
export function tier3IqAttestationLookup(
  rows: IqAttestationRow[],
  commitment: string,
): IqAttestationRow | null {
  for (const row of rows) {
    if (row.commitment === commitment && row.signed_by_child) return row;
  }
  return null;
}

/**
 * Compose the three tiers into a single decision. This is the SDK's
 * client-side hint; the worker re-derives independently.
 *
 * Decision rules (from packages/sdk-v2/CONTRACT.md):
 *   - Tier-1 hit → action = "replay" (with optional score boost from tier-2 strong)
 *   - Tier-1 miss + tier-2 strong → "live_fetch_direct" (bookmarked domains are more likely to accept direct fetch)
 *   - Tier-1 miss + tier-2 weak → "live_fetch_iproyal" (visited domains but unknown — use residential)
 *   - Tier-1 miss + tier-2 null + tier-3 attestation exists → "live_fetch_iproyal" (route exists somewhere, just not local — try residential)
 *   - Tier-1 miss + tier-2 null + tier-3 miss → "live_fetch_with_captcha" (unknown frontier, expect challenge)
 *
 * Anti-bot escalation ladder: replay → direct → residential → captcha.
 */
export function composeOnChainDecision(
  tier1: RouteCacheRow | null,
  tier2: "strong" | "weak" | null,
  tier3: IqAttestationRow | null,
): OnChainRouteDecision {
  if (tier1) {
    const scoreBoost = tier2 === "strong" ? 1.5 : 1.0;
    return {
      action: "replay",
      endpoint_id: tier1.endpoint_id,
      commitment: tier1.commitment,
      attested_on_chain: tier3 !== null && tier3.commitment === tier1.commitment,
      preference_bias: tier2,
      reason: `tier1 cache hit (score ${tier1.score * scoreBoost}${tier2 === "strong" ? ", +50% strong-pref boost" : ""}${tier3 ? ", tier3 attested" : ""})`,
    };
  }

  if (tier2 === "strong") {
    return {
      action: "live_fetch_direct",
      preference_bias: "strong",
      reason: "tier1 miss + bookmarked eTLD+1 → try direct (bookmarked domains usually accept)",
    };
  }

  if (tier2 === "weak") {
    return {
      action: "live_fetch_iproyal",
      preference_bias: "weak",
      reason: "tier1 miss + recently-visited eTLD+1 → residential (visited but unverified)",
    };
  }

  if (tier3) {
    return {
      action: "live_fetch_iproyal",
      commitment: tier3.commitment,
      attested_on_chain: true,
      preference_bias: null,
      reason: "tier1 + tier2 miss + tier3 attestation exists → residential (route exists on-chain, fetch via residential to maximize landing chance)",
    };
  }

  return {
    action: "live_fetch_with_captcha",
    preference_bias: null,
    reason: "all tiers miss → unknown frontier, expect captcha challenge",
  };
}

/**
 * Extract the eTLD+1 from a URL. Subdomain/path/query stripped by
 * construction — only the registrable domain leaves this function. Used by
 * tier2PreferenceBias so the KV-chain never receives subdomain pixels.
 *
 * This is a simplified implementation (no public suffix list). For unknown
 * TLDs it falls back to the hostname. A production version would consult
 * `tldts` or similar; this matches the simplification in `src/chrome/`.
 */
export function etldPlusOne(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = host.split(".");
    if (parts.length < 2) return host || null;
    // Take the last two parts. Misses co.uk etc. but matches the simplification
    // in src/chrome/CONTRACT.md's eTLD+1 handling.
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}
