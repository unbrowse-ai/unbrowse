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
// Takedown / opt-out primitives.
//
// A verified domain owner can take their domain DOWN from the marketplace.
// The DNS-TXT proof is the same primitive as the claim flow, but the value is
// `unbrowse-takedown=<challenge>` (no wallet field, takedown is binary).
//
// On verify, every SkillManifest whose domain matches gets lifecycle set to
// "disabled", AND a persistent `domain-optout:<domain>` KV key is written so
// future captures of the same domain do not publish.
// ---------------------------------------------------------------------------

/**
 * TXT record value the site owner must publish to prove a takedown request.
 * Unlike the claim TXT value, the takedown TXT does not embed a wallet:
 * takedown is a binary "this domain is off the marketplace" signal, not a
 * payout binding.
 */
export function buildTakedownTxtValue(challenge: string): string {
  return `unbrowse-takedown=${challenge}`;
}

/**
 * KV key for a pending takedown challenge. Scoped on domain only — there is
 * no wallet to bind, and the same DNS record is the proof regardless of who
 * minted the challenge. TTL'd 24h, same as the claim challenge.
 */
export function buildTakedownChallengeKey(domain: string): string {
  return `domain-takedown-challenge:${domain.trim().toLowerCase()}`;
}

/**
 * KV key for the persistent opt-out record (no TTL). Once written, the publish
 * path in services/marketplace.ts:publishSkill MUST consult this key before
 * writing a new skill for the same domain and skip publication when present.
 */
export function buildOptOutKey(domain: string): string {
  return `domain-optout:${domain.trim().toLowerCase()}`;
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

export interface DomainTakedownChallenge {
  domain: string;
  challenge: string;
  txt_name: string;
  txt_value: string;
  created_at: string;
  expires_at: string;
  agent_id: string;
}

/**
 * Persistent opt-out record (no TTL). The PRESENCE of `domain-optout:<domain>`
 * in statsKV is the gate; the JSON shape captures the audit trail. The
 * publish path in services/marketplace.ts:publishSkill consults this key
 * before writing a new skill for the same domain and aborts when present.
 */
export interface DomainTakedownRecord {
  domain: string;
  verified_at: string;
  verified_by_agent_id: string;
  txt_value_witness: string;
  doh_attestations: Array<{ provider: string; observed_at: string }>;
  reason?: string;
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
// Dual-DoH attestation primitive.
//
// Cloudflare DoH AND Google DoH must independently return a TXT at <txtName>
// whose de-quoted, multi-segment-concatenated value equals <expectedValue>.
// Single-provider success is rejected (anti-spoofing gate from
// firmament-step2.md "Architecture separations" #8).
// ---------------------------------------------------------------------------

export type VerifyTxtAttestation = { provider: string; observed_at: string };

export type VerifyTxtResult =
  | { ok: true; attestations: VerifyTxtAttestation[] }
  | { ok: false; reason: string; detail?: unknown };

interface DohAnswer {
  name?: string;
  type?: number;
  TTL?: number;
  data?: string;
}

interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

interface ProviderObservation {
  name: string;
  status: "matched" | "no_record" | "non_match" | "http_error" | "network_error";
  http_status?: number;
  observed_values: string[];
}

const DOH_CLOUDFLARE_URL_DEFAULT =
  "https://cloudflare-dns.com/dns-query";
const DOH_GOOGLE_URL_DEFAULT = "https://dns.google/resolve";
const DOH_TIMEOUT_MS = 4_000;
const DOH_MAX_BYTES = 8 * 1024;

function dohEndpoint(envName: string, fallback: string): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const override = env?.[envName];
  return override && override.trim() ? override.trim() : fallback;
}

/**
 * Strip surrounding double-quotes from one DoH TXT segment, and concatenate
 * multi-segment runs that the resolver returned space-separated as
 * `"chunk1" "chunk2"`. Whitespace between segments is dropped per RFC 1035
 * §3.3.14: contiguous character-strings form one logical TXT value.
 */
export function normalizeDohTxtData(raw: string): string {
  if (typeof raw !== "string") return "";
  // Match every "..."-delimited segment (handles \" escapes defensively) and
  // join them with no separator. Some resolvers also return data unquoted for
  // short TXT records; fall through to a trim in that case.
  const re = /"((?:[^"\\]|\\.)*)"/g;
  const segments: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    segments.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  if (segments.length === 0) return raw.trim();
  return segments.join("").trim();
}

async function queryProvider(
  providerName: string,
  url: string,
  txtName: string,
  expectedValue: string,
  fetchImpl: typeof fetch,
): Promise<ProviderObservation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  const full = `${url}${url.includes("?") ? "&" : "?"}name=${encodeURIComponent(txtName)}&type=TXT`;
  try {
    const res = await fetchImpl(full, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/dns-json" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { name: providerName, status: "http_error", http_status: res.status, observed_values: [] };
    }
    const text = (await res.text()).slice(0, DOH_MAX_BYTES);
    let parsed: DohResponse;
    try {
      parsed = JSON.parse(text) as DohResponse;
    } catch {
      return { name: providerName, status: "http_error", http_status: res.status, observed_values: [] };
    }
    const answers = Array.isArray(parsed.Answer) ? parsed.Answer : [];
    const txtAnswers = answers.filter((a) => a.type === 16 && typeof a.data === "string");
    if (txtAnswers.length === 0) {
      return { name: providerName, status: "no_record", http_status: res.status, observed_values: [] };
    }
    const observed = txtAnswers.map((a) => normalizeDohTxtData(a.data as string));
    if (observed.some((v) => v === expectedValue)) {
      return { name: providerName, status: "matched", http_status: res.status, observed_values: observed };
    }
    return { name: providerName, status: "non_match", http_status: res.status, observed_values: observed };
  } catch (err) {
    clearTimeout(timer);
    return {
      name: providerName,
      status: "network_error",
      observed_values: [(err as Error).message ?? "network_error"],
    };
  }
}

/**
 * Verify that BOTH Cloudflare DoH AND Google DoH independently return a TXT
 * record at `txtName` whose de-quoted, segment-concatenated value equals
 * `expectedValue` byte-for-byte.
 *
 * Endpoints (overridable via UNBROWSE_DOH_CLOUDFLARE_URL / UNBROWSE_DOH_GOOGLE_URL):
 *   - Cloudflare: https://cloudflare-dns.com/dns-query
 *   - Google:     https://dns.google/resolve
 *
 * Each call runs in parallel with a 4s AbortController, 8KB response cap,
 * redirect: "manual". The third `fetchImpl` arg defaults to globalThis.fetch
 * and exists so tests can inject canned application/dns-json responses
 * without spinning up a real HTTP server.
 *
 * Result rules:
 *   - Both providers matched ......... { ok: true, attestations: [..., ...] }
 *   - One matched, one did not ....... { ok: false, reason: "partial_propagation" }
 *   - Neither matched (have records) . { ok: false, reason: "dns_mismatch" }
 *   - Neither matched (no records) ... { ok: false, reason: "dns_mismatch" }
 *   - Any network/HTTP failure ....... { ok: false, reason: "doh_unreachable" }
 */
export async function verifyTxtBothProviders(
  txtName: string,
  expectedValue: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<VerifyTxtResult> {
  const cfUrl = dohEndpoint("UNBROWSE_DOH_CLOUDFLARE_URL", DOH_CLOUDFLARE_URL_DEFAULT);
  const goUrl = dohEndpoint("UNBROWSE_DOH_GOOGLE_URL", DOH_GOOGLE_URL_DEFAULT);

  const [cf, go] = await Promise.all([
    queryProvider("cloudflare", cfUrl, txtName, expectedValue, fetchImpl),
    queryProvider("google", goUrl, txtName, expectedValue, fetchImpl),
  ]);

  const observations: ProviderObservation[] = [cf, go];
  const observedAt = new Date().toISOString();

  // Any provider that could not be reached at all is fatal — we have no
  // attestation, so we cannot prove the record exists.
  if (observations.some((o) => o.status === "network_error" || o.status === "http_error")) {
    return {
      ok: false,
      reason: "doh_unreachable",
      detail: {
        providers: observations.map((o) => ({
          name: o.name,
          status: o.status,
          http_status: o.http_status,
          observed_values: o.observed_values,
        })),
      },
    };
  }

  const matched = observations.filter((o) => o.status === "matched");

  if (matched.length === observations.length) {
    return {
      ok: true,
      attestations: matched.map((m) => ({ provider: m.name, observed_at: observedAt })),
    };
  }

  // Partial: exactly one provider matched. The other either returned no
  // record or returned a different value. Surface this as a soft state so
  // the UI can render a "propagating, retry in 1-5 min" hint per
  // firmament-step2.md "Edge case decisions".
  if (matched.length === 1) {
    return {
      ok: false,
      reason: "partial_propagation",
      detail: {
        providers: observations.map((o) => ({
          name: o.name,
          status: o.status,
          observed_values: o.observed_values,
        })),
      },
    };
  }

  return {
    ok: false,
    reason: "dns_mismatch",
    detail: {
      providers: observations.map((o) => ({
        name: o.name,
        status: o.status,
        observed_values: o.observed_values,
      })),
    },
  };
}
