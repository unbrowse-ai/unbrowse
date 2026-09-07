/**
 * src/lib/extract-auth-header.ts — pull an auth header out of a natural-language intent.
 *
 * The agent expresses auth in words ("authenticate with bearer token abc123 then read …",
 * "use api key sk-live-… to fetch …"). The one-hole read path uses this to synthesize an
 * Authorization / X-API-Key header and do a DIRECT authenticated fetch, instead of the
 * resolve+capture ladder (which carries no header and times out). An explicit --header
 * flag always wins over extraction.
 *
 * Pure + dependency-free → unit-testable without a CLI or network. Conservative by design:
 * it only fires on an explicit auth phrasing + a token-shaped value, so a plain read is
 * never mis-classified as authenticated.
 */

// A token-shaped value: long-ish, no spaces, the charset real API tokens use.
const TOKEN = "([A-Za-z0-9][A-Za-z0-9._~+/=-]{5,})";

const BEARER_RULES: RegExp[] = [
  new RegExp(`\\bbearer\\s+token\\s+${TOKEN}`, "i"),
  new RegExp(`\\bbearer\\s+${TOKEN}`, "i"),
  new RegExp(`\\b(?:auth(?:enticate|orization)?)\\s+(?:with\\s+)?token\\s+${TOKEN}`, "i"),
];

const APIKEY_RULES: RegExp[] = [
  new RegExp(`\\b(?:api[- ]?key|apikey|x-api-key)\\s*[:=]?\\s+${TOKEN}`, "i"),
];

// A captured value is a real credential — not an English word like "tokens" — only when
// it carries a digit or a token special char, OR mixes case, OR is long. This keeps
// "bearer tokens work" (the plain word) from being mis-read as a credential.
function looksLikeToken(t: string): boolean {
  if (t.length >= 16) return true;
  if (/[0-9._~+/=-]/.test(t)) return true;
  if (/[A-Z]/.test(t) && /[a-z]/.test(t)) return true;
  return false;
}

/**
 * @returns an HTTP header line ("Authorization: Bearer <t>" or "X-API-Key: <k>") extracted
 *          from the intent, or undefined when no auth credential is present.
 */
export function extractAuthHeader(intent: string): string | undefined {
  if (!intent) return undefined;
  for (const re of BEARER_RULES) {
    const m = intent.match(re);
    if (m?.[1] && looksLikeToken(m[1])) return `Authorization: Bearer ${m[1]}`;
  }
  for (const re of APIKEY_RULES) {
    const m = intent.match(re);
    if (m?.[1] && looksLikeToken(m[1])) return `X-API-Key: ${m[1]}`;
  }
  return undefined;
}
