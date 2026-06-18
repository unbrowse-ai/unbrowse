// Server-authoritative publish sanitization.
//
// PORT of the canonical client redactors in `src/publish/sanitize.ts`
// (`looksLikeSecret`, `redactSecrets`, `sanitizeForPublish`, plus the
// `synthesizeExample` / `synthesizePlaceholder` / `sanitizeAgentVisible*`
// helpers they depend on). The backend is a Cloudflare Worker with its own
// tsconfig (rootDir: "src", no imports across the workspace boundary), so a
// clean shared import is not feasible — this is a deliberate dependency-free
// port.
//
// The two copies MUST stay byte-for-byte equivalent in REDACTION BEHAVIOUR.
// `backend/tests/sanitize-parity.test.ts` is the falsifier: it feeds an
// identical fixture through this module and the client module and asserts
// deep-equal output. Any divergence fails CI. Do NOT "improve" one side
// without the other — the "lives in N files, keep in sync" hazard documented
// in CLAUDE.md applies here verbatim.
//
// Redaction is by EVIDENCE — token shape, Shannon-ish length/charset, known
// secret header/field names, PII patterns — never by invented per-site or
// per-publisher policy. The substrate redacts what looks like a secret; it
// does not decide what a publisher "meant" to share.
//
// Endpoints here are typed structurally as `SanitizableEndpoint` rather than
// the worker `EndpointDescriptor` because the publish body arrives untyped
// (`unknown[]`) and the worker/CLI `EndpointDescriptor` interfaces diverge
// (the worker one lacks `semantic` / `path_params` / `body_params`).
// Redaction is shape-driven, so a structural type is the correct contract.

export interface SanitizableEndpoint {
  endpoint_id?: string;
  method?: string;
  url_template?: string;
  description?: string;
  headers_template?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  body_params?: Record<string, unknown>;
  path_params?: Record<string, string>;
  trigger_url?: string;
  semantic?: {
    example_request?: unknown;
    example_response_compact?: unknown;
    sample_request_url?: string;
    requires?: Array<Record<string, unknown>>;
    provides?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const SECRET_VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+\S+/i,
  /^Basic\s+[A-Za-z0-9+/=]+/i,
  /^ghp_[A-Za-z0-9]{36}/,
  /^sk-[A-Za-z0-9]{20,}/,
  /^pk_(live|test)_[A-Za-z0-9]+/,
  /^xox[bsrp]-[A-Za-z0-9-]+/,
  /^AKIA[A-Z0-9]{16}/,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  /^v2\.[A-Za-z0-9_-]{20,}/,
];

const SECRET_KEY_PATTERNS = /^(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|password|passwd|session[_-]?id|session[_-]?token|csrf[_-]?token|client[_-]?secret|bearer|refresh[_-]?token|id[_-]?token|jwt|nonce|otp|pin|ssn|credit[_-]?card)$/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\w)(?:\+?\d[\d\s-]{7,}\d)(?!\w)/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;
const LONG_ID_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;

/** A wallet-bound commitment (zkbind:y.root.sig) — one-way point + signature, never
 *  the credential. The SAFE form a secret takes on the wire, not a leak. */
function isBoundCommitment(value: string): boolean {
  if (!value.startsWith("zkbind:")) return false;
  const parts = value.slice("zkbind:".length).split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function looksLikeSecret(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length < 8) return false;
  // A wallet-bound commitment is secret-free by construction — admit the standard
  // hole interface by design, not reject it by the entropy regex.
  if (isBoundCommitment(value)) return false;
  if (SECRET_KEY_PATTERNS.test(key)) return true;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeAgentVisibleText(text: string): string {
  return text
    .replace(JWT_PATTERN, "[secret-token]")
    .replace(EMAIL_PATTERN, "user@example.com")
    .replace(PHONE_PATTERN, "[phone]")
    .replace(UUID_PATTERN, "00000000-0000-0000-0000-000000000000")
    .replace(CREDIT_CARD_PATTERN, "[sensitive-number]")
    .replace(URL_PATTERN, (value) => {
      if (/^https?:\/\/example\.com/i.test(value)) return value;
      return "https://example.com/resource";
    })
    .replace(LONG_ID_PATTERN, (value) => {
      if (looksLikeSecret("", value)) return "[secret-token]";
      return value;
    });
}

export function sanitizeAgentVisibleValue(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return synthesizePlaceholder(key, sanitizeAgentVisibleText(value));
  }
  if (Array.isArray(value)) return value.slice(0, 3).map((entry) => sanitizeAgentVisibleValue(key, entry));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeAgentVisibleValue(childKey, childValue);
    }
    return out;
  }
  return synthesizePlaceholder(key, value);
}

export function redactSecrets(obj: unknown, parentKey = ""): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return looksLikeSecret(parentKey, obj) ? "[REDACTED]" : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item, parentKey));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactSecrets(value, key);
    }
    return result;
  }
  return obj;
}

function synthesizePlaceholder(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isInteger(value) ? 12345 : 99.99;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (looksLikeSecret(key, value)) return "[REDACTED]";
    if (/@/.test(value)) return "user@example.com";
    if (/^https?:\/\//.test(value)) return "https://example.com/item/123";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(value)) return "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    if (/^\d+$/.test(value)) return "12345";
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "2026-01-15T00:00:00Z";
    if (value.length <= 8) return "abc123";
    if (value.length > 100) return "Example description text for this item.";
    return "example-value";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? [synthesizeExample(value[0], 0)] : [];
  }
  if (typeof value === "object") {
    return synthesizeExample(value, 0);
  }
  return value;
}

export function synthesizeExample(obj: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return synthesizePlaceholder("", obj);
  if (Array.isArray(obj)) {
    return obj.slice(0, 2).map((item) => synthesizeExample(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = typeof value === "object" && value !== null
      ? synthesizeExample(value, depth + 1)
      : synthesizePlaceholder(key, value);
  }
  return result;
}

export function sanitizeForPublish<T extends SanitizableEndpoint>(endpoints: T[]): T[] {
  return endpoints.map((endpoint) => {
    const clean = { ...endpoint } as SanitizableEndpoint;

    // headers_template is never published to the marketplace — not even empty placeholder
    // keys. Credentials are injected exclusively from the user's private vault at execution
    // time. The schema signal (auth_required) in semantic.requires already tells the agent
    // that auth is needed without exposing which headers to use.
    delete clean.headers_template;

    if (clean.query) {
      clean.query = redactSecrets(clean.query) as Record<string, unknown>;
    }
    if (clean.body) {
      clean.body = redactSecrets(clean.body) as Record<string, unknown>;
    }
    if (clean.query) {
      clean.query = Object.fromEntries(
        Object.entries(clean.query).map(([key, value]) => [key, typeof value === "string" ? "example" : value]),
      );
    }
    if (clean.path_params) {
      clean.path_params = Object.fromEntries(
        Object.keys(clean.path_params).map((key) => [key, "example"]),
      );
    }
    if (clean.body) clean.body = synthesizeExample(clean.body) as Record<string, unknown>;
    if (clean.body_params) clean.body_params = synthesizeExample(clean.body_params) as Record<string, unknown>;

    if (clean.trigger_url) {
      try {
        const parsed = new URL(clean.trigger_url);
        clean.trigger_url = parsed.origin + parsed.pathname;
      } catch {
        /* keep original */
      }
    }

    if (clean.semantic) {
      const semantic = { ...clean.semantic };
      if (semantic.example_response_compact) {
        semantic.example_response_compact = synthesizeExample(semantic.example_response_compact);
      }
      if (semantic.example_request) {
        semantic.example_request = synthesizeExample(semantic.example_request);
      }
      if (semantic.sample_request_url) {
        try {
          const parsed = new URL(semantic.sample_request_url);
          for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "example");
          semantic.sample_request_url = parsed.toString();
        } catch {
          delete semantic.sample_request_url;
        }
      }
      if (semantic.requires) {
        semantic.requires = semantic.requires.map((binding) => {
          const { example_value: _exampleValue, ...rest } = binding;
          return rest;
        });
      }
      if (semantic.provides) {
        semantic.provides = semantic.provides.map((binding) => {
          const { example_value: _exampleValue, ...rest } = binding;
          return rest;
        });
      }
      clean.semantic = semantic;
    }

    return clean as T;
  });
}

/**
 * Server-authoritative re-sanitization for the publish route.
 *
 * Scrub-and-continue is the default — a stale/tampered client that skipped
 * `sanitizeForPublish` still cannot leak the user's own secrets into the
 * PUBLIC marketplace, because every published endpoint is re-run through the
 * identical redaction core here. We HARD-REJECT only structural leakage that
 * survives scrubbing (a `[REDACTED]` marker that still has secret-shaped
 * siblings the scrub could not place), which indicates a malformed/hostile
 * payload rather than an honest stale client.
 *
 * Returns the scrubbed endpoints plus a flag the route stamps onto the
 * manifest (`server_sanitized: true`) so downstream consumers know the
 * server, not the client, is the redaction authority.
 */
export function enforcePublishSanitization(rawEndpoints: unknown): {
  endpoints: SanitizableEndpoint[];
  server_sanitized: true;
} {
  if (!Array.isArray(rawEndpoints)) {
    return { endpoints: [], server_sanitized: true };
  }
  const sanitized = sanitizeForPublish(
    rawEndpoints.filter((e): e is SanitizableEndpoint => !!e && typeof e === "object") as SanitizableEndpoint[],
  );
  return { endpoints: sanitized, server_sanitized: true };
}

/**
 * Structural-leakage detector. Walks the SANITIZED endpoints and reports any
 * remaining string value that still `looksLikeSecret`. Used by the publish
 * route to 422-reject payloads whose secrets the scrub could not neutralize
 * (e.g. a secret embedded in a field the redactor does not traverse, such as
 * a free-text `description` containing a raw bearer token). This is the
 * substrate telling the truth about what survived, not invented policy.
 */
export function detectResidualSecretLeak(endpoints: SanitizableEndpoint[]): string[] {
  const hits: string[] = [];
  const walk = (obj: unknown, parentKey: string, path: string) => {
    if (obj === null || obj === undefined) return;
    if (typeof obj === "string") {
      if (looksLikeSecret(parentKey, obj)) hits.push(path || parentKey);
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, parentKey, `${path}[${i}]`));
      return;
    }
    if (typeof obj === "object") {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        walk(value, key, path ? `${path}.${key}` : key);
      }
    }
  };
  for (let i = 0; i < endpoints.length; i++) {
    walk(endpoints[i], "", `endpoints[${i}]`);
  }
  return hits;
}
