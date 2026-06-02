/**
 * obfuscate-capture-for-reveng — strip every secret/PII *value* from a captured
 * request set while preserving the *structure* the reverse-engineer needs
 * (URL route shape, method, header/param NAMES, response field NAMES + types).
 *
 * This is the foundation of "browse with your credentials completely obfuscated,
 * let the backend reverse-engineer the route": the reveng derives an endpoint
 * spec from STRUCTURE, never from the secret VALUE — so the obfuscated capture
 * can be handed to a (closed) backend reveng engine and the agent's auth tokens,
 * cookies, passwords, and PII never leave the client in the clear. The real
 * values are restored at EXECUTION time from the local auth-profile vault
 * (per-domain), not carried in the obfuscated capture — so this transform is
 * deliberately one-way and lossless of structure, lossy of secrets.
 *
 * ZK is the future provability upgrade (prove the obfuscated credential is bound
 * to the wallet without revealing it). This primitive is the redaction layer ZK
 * later strengthens; it needs no ZK to be correct.
 */
import type { RawRequest } from "./index.js";
import { looksLikeSecret, sanitizeAgentVisibleText, redactSecrets } from "../publish/sanitize.js";

const REDACTED = "[REDACTED]";

// Header names whose VALUE is always a secret regardless of shape.
const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|x-csrf-token|csrf-token|x-xsrf-token|x-api-key|x-auth-token|x-access-token|x-session-token|proxy-authorization|x-amz-security-token|x-goog-api-key|api-key|apikey|x-secret|x-token)$/i;

function obfuscateHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    out[k] = SENSITIVE_HEADER.test(k) || looksLikeSecret(k, v) ? REDACTED : sanitizeAgentVisibleText(String(v));
  }
  return out;
}

/** Keep the route shape; redact secret query values + opaque id-like path
 *  segments (long hex/uuid/secret) so the endpoint template survives but the
 *  per-user identifiers do not. */
function obfuscateUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      const val = u.searchParams.get(key) ?? "";
      u.searchParams.set(key, looksLikeSecret(key, val) ? REDACTED : sanitizeAgentVisibleText(val));
    }
    u.pathname = u.pathname
      .split("/")
      .map((seg) => {
        if (!seg) return seg;
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg);
        const isOpaque = seg.length >= 16 && (/^[0-9a-f]+$/i.test(seg) || looksLikeSecret("", seg));
        return isUuid || isOpaque ? "{id}" : seg;
      })
      .join("/");
    // URL.toString() percent-encodes the {} of the route placeholder; restore it
    // so the endpoint template stays readable for the reverse-engineer.
    return u.toString().replace(/%7[Bb]id%7[Dd]/g, "{id}");
  } catch {
    return sanitizeAgentVisibleText(url);
  }
}

/** JSON bodies: recurse + redact secret-keyed values, keep the schema (keys +
 *  shapes). Non-JSON bodies: text-sanitize (JWTs, emails, tokens -> placeholders). */
function obfuscateBody(body: string | undefined): string | undefined {
  if (body == null || body === "") return body;
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      // Two passes: redactSecrets handles secret-keyed values + key/value
      // secret patterns (password, tokens) -> [REDACTED]; the text-sanitize pass
      // then catches PII the secret heuristics miss (emails, UUIDs, phone,
      // credit-card, embedded JWTs) inside the remaining string values. JSON
      // structure (keys + non-sensitive numbers) survives both.
      return sanitizeAgentVisibleText(JSON.stringify(redactSecrets(JSON.parse(trimmed))));
    } catch {
      /* fall through to text sanitize */
    }
  }
  return sanitizeAgentVisibleText(body);
}

/**
 * Obfuscate a captured request set for a backend reverse-engineer: every secret
 * value (auth headers, cookies, tokens, passwords, PII, opaque ids) is redacted;
 * the reveng-able structure (route template, method, header/param names,
 * response schema) is preserved.
 */
export function obfuscateRequestForReveng(r: RawRequest): RawRequest {
  return {
    ...r,
    url: obfuscateUrl(r.url),
    request_headers: obfuscateHeaders(r.request_headers),
    request_body: obfuscateBody(r.request_body),
    response_headers: obfuscateHeaders(r.response_headers),
    response_body: obfuscateBody(r.response_body),
  };
}

export function obfuscateCaptureForReveng(requests: RawRequest[]): RawRequest[] {
  return requests.map(obfuscateRequestForReveng);
}
