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
 * When a wallet pubkey is supplied, each redacted secret is replaced not by a
 * flat `[REDACTED]` but by its WALLET-BOUND tag (`[bound:<commitment>]`) — a
 * deterministic hash that hides the value yet binds it to the owner's wallet, so
 * the obfuscated capture proves "this field is a secret bound to wallet W"
 * without revealing it (the secret itself stays in the owner's local vault —
 * owner-only USE). See `wallet-bind.ts`.
 *
 * ZK is the future provability upgrade (prove the obfuscated credential is bound
 * to the wallet without revealing it). This primitive is the redaction +
 * commitment layer ZK later strengthens; it needs no ZK to be correct.
 */
import type { RawRequest } from "./index.js";
import { looksLikeSecret, sanitizeAgentVisibleText, redactSecrets } from "../publish/sanitize.js";
import { makeRedactor } from "./wallet-bind.js";

const REDACTED = "[REDACTED]";

/** A redaction function: given the original secret string, returns its
 *  placeholder — plain `[REDACTED]` or a wallet-bound `[bound:<...>]` tag. */
type Redactor = (secret: string) => string;

// Header names whose VALUE is always a secret regardless of shape.
const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|x-csrf-token|csrf-token|x-xsrf-token|x-api-key|x-auth-token|x-access-token|x-session-token|proxy-authorization|x-amz-security-token|x-goog-api-key|api-key|apikey|x-secret|x-token)$/i;

function obfuscateHeaders(h: Record<string, string> | undefined, redact: Redactor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    out[k] = SENSITIVE_HEADER.test(k) || looksLikeSecret(k, v) ? redact(String(v)) : sanitizeAgentVisibleText(String(v));
  }
  return out;
}

/** Keep the route shape; redact secret query values + opaque id-like path
 *  segments (long hex/uuid/secret) so the endpoint template survives but the
 *  per-user identifiers do not. */
function obfuscateUrl(url: string, redact: Redactor): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      const val = u.searchParams.get(key) ?? "";
      u.searchParams.set(key, looksLikeSecret(key, val) ? redact(val) : sanitizeAgentVisibleText(val));
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
    // URL.toString() percent-encodes the {} of the route placeholder and the
    // [bound:..] / [REDACTED] tags; restore them so the template + the
    // wallet-binding stay readable for the reverse-engineer.
    return u
      .toString()
      .replace(/%7[Bb]id%7[Dd]/g, "{id}")
      .replace(/%5[Bb]bound%3[Aa]([0-9a-f]{16})%5[Dd]/gi, "[bound:$1]")
      .replace(/%5[Bb]REDACTED%5[Dd]/gi, REDACTED);
  } catch {
    return sanitizeAgentVisibleText(url);
  }
}

/** Recurse a parsed JSON value, redacting secret-keyed string values via the
 *  redactor (the value's original text is in hand, so it can be wallet-bound);
 *  non-secret structure is left for the text-sanitize pass. Mirrors
 *  `redactSecrets` but routes the placeholder through `redact`. */
function redactSecretsWith(obj: unknown, redact: Redactor, parentKey = ""): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return looksLikeSecret(parentKey, obj) ? redact(obj) : obj;
  if (Array.isArray(obj)) return obj.map((item) => redactSecretsWith(item, redact, parentKey));
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactSecretsWith(value, redact, key);
    }
    return result;
  }
  return obj;
}

/** JSON bodies: recurse + redact secret-keyed values, keep the schema (keys +
 *  shapes). Non-JSON bodies: text-sanitize (JWTs, emails, tokens -> placeholders). */
function obfuscateBody(body: string | undefined, redact: Redactor): string | undefined {
  if (body == null || body === "") return body;
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      // Two passes: redactSecretsWith handles secret-keyed values + key/value
      // secret patterns (password, tokens) -> placeholder (wallet-bound when a
      // wallet is given); the text-sanitize pass then catches PII the secret
      // heuristics miss (emails, UUIDs, phone, credit-card, embedded JWTs) inside
      // the remaining string values. JSON structure survives both. The bound
      // tags `[bound:..]` carry only hex + are untouched by the text pass.
      return sanitizeAgentVisibleText(JSON.stringify(redactSecretsWith(JSON.parse(trimmed), redact)));
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
export interface ObfuscateOpts {
  /** When set, each redacted secret becomes its wallet-bound commitment tag
   *  (`[bound:<...>]`) instead of a flat `[REDACTED]` — proving the field is a
   *  secret bound to this wallet without revealing the value. */
  walletPubkey?: string;
}

export function obfuscateRequestForReveng(r: RawRequest, opts: ObfuscateOpts = {}): RawRequest {
  const redact = makeRedactor(opts.walletPubkey);
  return {
    ...r,
    url: obfuscateUrl(r.url, redact),
    request_headers: obfuscateHeaders(r.request_headers, redact),
    request_body: obfuscateBody(r.request_body, redact),
    response_headers: obfuscateHeaders(r.response_headers, redact),
    response_body: obfuscateBody(r.response_body, redact),
  };
}

export function obfuscateCaptureForReveng(requests: RawRequest[], opts: ObfuscateOpts = {}): RawRequest[] {
  return requests.map((r) => obfuscateRequestForReveng(r, opts));
}
