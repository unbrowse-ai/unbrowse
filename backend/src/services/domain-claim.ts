/**
 * Domain-wallet DNS-TXT claim primitive.
 *
 * Contract source: .claude/firmament-step2.md
 *
 * SEED-ONLY for Step 2. Pure helpers + types compile against the existing
 * backend tsconfig. The dual-DoH attestation primitive, KV reads/writes, and
 * settlement integration land in Step 4 (see the "Step 4" comment markers
 * inside verifyTxtBothProviders below).
 *
 * Boundary: this file owns the DoH primitive plus KV key shape and JSON shapes.
 * Routes live in routes/claim.ts. Flex math stays in services/flex.ts.
 */

// ---------------------------------------------------------------------------
// KV key builders. Mirror the schema in .claude/firmament-step2.md "Data model".
// ---------------------------------------------------------------------------

/**
 * TXT record name the site owner must publish under their apex zone.
 * Always lowercased to match RFC 1035 case-insensitivity and the ingress
 * normalization rule in firmament-step2.md "Edge case decisions".
 */
export function buildTxtName(domain: string): string {
  return `_unbrowse-claim.${domain.trim().toLowerCase()}`;
}

/**
 * TXT record value the site owner must publish. Embeds both the challenge and
 * the wallet so the record cannot be replayed against a different wallet.
 */
export function buildTxtValue(challenge: string, wallet: string): string {
  return `unbrowse-claim=${challenge};wallet=${wallet}`;
}

/**
 * KV key for a pending claim challenge. Scoped on (domain, wallet) so the same
 * DNS record cannot satisfy a second wallet later. TTL'd 24h in step 4.
 */
export function buildChallengeKey(domain: string, wallet: string): string {
  return `domain-claim-challenge:${domain.trim().toLowerCase()}:${wallet}`;
}

/**
 * KV key for the long-lived verified domain->wallet binding (no TTL).
 */
export function buildBindingKey(domain: string): string {
  return `domain-wallet:${domain.trim().toLowerCase()}`;
}

/**
 * KV key for the per-domain rate-limit counter on challenge mints
 * (10/hour cap, TTL 3600s; enforced in step 4).
 */
export function buildRateLimitKey(domain: string): string {
  return `domain-claim-rl:${domain.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Stored shapes. JSON contracts in KV — keep schema_version on the binding so
// readers can migrate v1 records without ambiguity in step 4+.
// ---------------------------------------------------------------------------

export interface DomainClaimChallenge {
  domain: string;
  wallet_address: string;
  challenge: string;
  txt_name: string;
  txt_value: string;
  created_at: string;
  expires_at: string;
  agent_id: string;
}

export interface DomainClaimBinding {
  domain: string;
  wallet_address: string;
  wallet_usdc_ata?: string;
  verified_at: string;
  verified_by_agent_id: string;
  txt_value_witness: string;
  doh_attestations: Array<{ provider: string; observed_at: string }>;
  schema_version: number;
}

// ---------------------------------------------------------------------------
// Validation primitives.
// ---------------------------------------------------------------------------

/**
 * Subdomain prefixes that should never be accepted as an apex claim in v1.
 * Apex-only is the v1 rule per firmament-step2.md "Edge case decisions". PSL
 * parsing for true subdomain claims is deferred to v2.
 */
const REJECTED_SUBDOMAIN_PREFIXES = [
  "www.",
  "api.",
  "app.",
  "blog.",
  "docs.",
  "mail.",
  "static.",
  "assets.",
  "cdn.",
  "m.",
];

/**
 * RFC-lite apex domain check. Lowercase ASCII letters/digits/hyphens plus dots.
 * Accepts shapes like "example.com" or "example.co.uk"; rejects obvious
 * subdomain hints by prefix match.
 *
 * v1 cap: this is intentionally not PSL-aware. If a site needs subdomain
 * claims, that lands in v2 with a real Public Suffix List dependency.
 */
export function isValidApexDomain(d: string): boolean {
  if (typeof d !== "string") return false;
  const lowered = d.trim().toLowerCase();
  if (!lowered) return false;
  if (lowered.length > 253) return false;
  if (!/^[a-z0-9-]+\.[a-z0-9-]+(\.[a-z]{2,})?$/.test(lowered)) return false;
  for (const prefix of REJECTED_SUBDOMAIN_PREFIXES) {
    if (lowered.startsWith(prefix)) return false;
  }
  // Reject leading/trailing hyphens in any label (RFC 1035).
  for (const label of lowered.split(".")) {
    if (!label || label.startsWith("-") || label.endsWith("-")) return false;
    if (label.length > 63) return false;
  }
  return true;
}

/**
 * Solana base58 pubkey shape check. Length 32-44, no 0/O/I/l characters.
 * Not a curve check — the on-chain side validates membership. This filters
 * obviously malformed strings before we mint a KV record.
 */
export function isValidSolanaPubkey(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

/**
 * 32-byte random challenge as 64 hex chars. Uses Web Crypto getRandomValues
 * because that's what runs in Cloudflare Workers (node:crypto.randomBytes is
 * unavailable). Same pattern as routes/auth.ts:genToken.
 */
export function mintChallenge(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Dual-DoH attestation primitive. Step 4 wires the real fetches; Step 2 ships
// the signature + the sketch in comments so the next step knows the contract.
// ---------------------------------------------------------------------------

export type VerifyTxtResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: unknown };

/**
 * Verify that BOTH Cloudflare DoH AND Google DoH independently return a TXT
 * record at `txtName` whose de-quoted, segment-concatenated, trimmed value
 * equals `expectedValue` byte-for-byte.
 *
 * Step 4 implementation contract (per firmament-step2.md "DNS verification
 * primitive"):
 *   - Endpoints:
 *       Cloudflare: https://cloudflare-dns.com/dns-query?name=<txtName>&type=TXT
 *         with header Accept: application/dns-json
 *       Google:     https://dns.google/resolve?name=<txtName>&type=TXT
 *   - Parallel fetches via AbortController, 4s timeout each.
 *   - redirect: "manual", credentials: "omit", 8 KB response cap.
 *   - Each provider must:
 *       1. Return HTTP 200.
 *       2. Parse JSON with at least one Answer entry of type 16 (TXT) whose
 *          data (DoH may return as "\"chunk1\" \"chunk2\"" — concatenate the
 *          inner segments after stripping surrounding quotes) equals
 *          expectedValue after whitespace trim.
 *   - Agreement rule: BOTH must succeed. No 1-of-2 partial accept.
 *   - On disagreement, return ok:false with reason "dns_mismatch" and a
 *     detail object listing each provider's observed_values for the route
 *     handler to surface back to the caller.
 *   - On network/HTTP failure, return ok:false with reason "doh_unreachable".
 *
 * STUB: returns not_implemented until step 4. Signature is final.
 */
export async function verifyTxtBothProviders(
  txtName: string,
  expectedValue: string,
): Promise<VerifyTxtResult> {
  // Reference the args so tsc --noUnusedParameters (if ever enabled) stays
  // quiet, and so the seed proves the contract surface is reachable.
  void txtName;
  void expectedValue;
  return { ok: false, reason: "not_implemented" };
}
