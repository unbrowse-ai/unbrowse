import type {
  EndpointDescriptor,
  OperationBinding,
  SkillOperationGraph,
  SkillOperationNode,
} from "../types/index.js";

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

/** A wallet-bound commitment (bind:y.root.sig — or the retired zkbind: tag) —
 *  one-way commitment + signature, never the credential. The SAFE form a secret
 *  takes on the wire, not a leak. Shape is checked STRICTLY so a secret-shaped
 *  value cannot masquerade as a binding: y is a derived ed25519 pubkey (64 hex;
 *  legacy zkbind points ran up to 512 hex), root is a 32-byte ed25519 pubkey
 *  (64 hex), sig is a 64-byte ed25519 signature (128 hex). A JWT / base64 /
 *  base58 secret fails the hex+length gate. (Full sig verification is
 *  verifyHoleAttested at admission.) */
const BOUND_TAG_PREFIXES = ["bind:", "zkbind:"] as const;
function boundTagPrefix(value: string): string | null {
  for (const p of BOUND_TAG_PREFIXES) if (value.startsWith(p)) return p;
  return null;
}
function isBoundCommitment(value: string): boolean {
  const prefix = boundTagPrefix(value);
  if (!prefix) return false;
  const parts = value.slice(prefix.length).split(".");
  if (parts.length !== 3) return false;
  const [y, root, sig] = parts;
  const isHex = (s: string): boolean => s.length > 0 && /^[0-9a-f]+$/i.test(s);
  const yMax = prefix === "bind:" ? 64 : 512;
  const yOk = isHex(y) && (prefix === "bind:" ? y.length === 64 : y.length >= 8 && y.length <= yMax);
  return yOk
    && isHex(root) && root.length === 64
    && isHex(sig) && sig.length === 128;
}

export function looksLikeSecret(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length < 8) return false;
  // A bound-tag prefix is a CLAIM of a wallet-bound commitment. Honor it only if the
  // commitment is well-formed (secret-free by construction); a malformed bound tag is
  // a forgery smuggling a secret behind the prefix — fail closed and flag it.
  if (boundTagPrefix(value)) return !isBoundCommitment(value);
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

/** A captured wire payload (a WS frame today) reduced to its shape. JSON keeps its keys
 *  and types via `synthesizeExample`; anything unparseable is not guessed at — an opaque
 *  frame is all value and no shape, so there is nothing to preserve by keeping it. */
function synthesizeWireText(data: string): string {
  const trimmed = (data ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(synthesizeExample(JSON.parse(trimmed)));
    } catch {
      /* not JSON after all — fall through */
    }
  }
  return "[example-frame]";
}

// ---------------------------------------------------------------------------
// The allowlist.
//
// This boundary used to be `const clean = { ...endpoint }` followed by a list of
// `delete`s: a DENY-NOTHING copy with the known-bad fields subtracted. That shape
// publishes EVERY FIELD ANYONE ADDS LATER, by default, and it has already leaked
// once — `proven_recipe` shipped a second copy of the captured auth headers because
// the denylist only knew about `headers_template`. A denylist cannot enumerate a
// field that does not exist yet, and the author of that field has no reason to know
// this file exists.
//
// So the shape is inverted: a field leaves ONLY if it is named here. The next field
// added to EndpointDescriptor is dropped at publish until someone reads this list and
// makes a decision about it. The failure mode moves from "silent leak" to "a new field
// is missing from the marketplace", which is loud, cheap, and not a breach.
//
// Sub-allowlists apply the same rule one level down, so a new key on CsrfPlan /
// OAuthPlan / EndpointConstraint / AuthTokenBinding is likewise refused by default.
// ---------------------------------------------------------------------------

/** Fields permitted to leave the client on a published endpoint. */
const PUBLISHED_ENDPOINT_FIELDS: ReadonlySet<string> = new Set([
  // --- route identity: the part a foreign agent actually replays ---
  "endpoint_id", "method", "url_template", "trigger_url", "graphql_info", "search_form",
  // --- request/response SHAPE: keys survive, values are placeholdered below ---
  "query", "path_params", "body", "body_params", "response_schema", "dom_extraction",
  "ws_messages", "proven_recipe",
  // --- prose: allowlisted but scrubbed below, never published verbatim ---
  "description", "semantic", "annotations",
  // --- auth MECHANISM (names/enums only, sub-allowlisted): never auth VALUES ---
  "csrf_plan", "auth_tokens", "oauth_plan",
  // --- learned constraints (sub-allowlisted: the rule, not the API's error text) ---
  "constraints", "policy",
  // --- lifecycle / scoring / server-owned bookkeeping ---
  "idempotency", "verification_status", "reliability_score", "last_verified_at",
  "signature", "transform_ref", "auth_walled", "graph_visibility", "corroboration",
  "owner_submitted", "pay_provider",
  // --- proof metadata: published BY DESIGN; the backend verifies it at admission ---
  "zk_proof",
]);

/**
 * REFUSED at the top level, and why — these are the fields the old denylist let through:
 *   headers_template            the captured cookie jar. Credentials come from the
 *                               replaying agent's OWN vault; auth_required already
 *                               signals "this needs auth" without naming the headers.
 *   _minedTemplate              the pre-templatisation URL, i.e. the real captured
 *   _path_binding_candidates    path segments a placeholder replaced. Internal capture
 *                               annotations that document themselves as not persisted.
 */

/** Fields permitted to leave on `semantic`. */
const PUBLISHED_SEMANTIC_FIELDS: ReadonlySet<string> = new Set([
  "action_kind", "resource_kind",
  "description_in", "description_out", "response_summary", "description_warning",
  "description_source", "description_needs_review",
  "example_request", "example_response_compact", "example_fields",
  "requires", "provides", "negative_tags", "confidence", "observed_at",
  "sample_request_url", "auth_required",
]);

/** `semantic` keys that are FREE TEXT written by a model over a real captured response. */
const SEMANTIC_PROSE_FIELDS = [
  "description_in", "description_out", "response_summary", "description_warning",
] as const;

/** CsrfPlan is a NAME→NAME mapping (which cookie feeds which header) plus two enums.
 *  It carries no captured value, and `executeEndpoint` reads it at replay time to mint
 *  a fresh token from the REPLAYING agent's own cookies — so it is published, pinned to
 *  exactly these four keys. A fifth key added upstream is refused until reviewed. */
const PUBLISHED_CSRF_PLAN_FIELDS: ReadonlySet<string> = new Set([
  "source", "param_name", "refresh_on_401", "extractor_sequence",
]);

/** OAuthPlan minus `token_url` and `refresh_path`. Nothing on the execute path reads
 *  either (only a marketplace quality score counts the plan's presence), and a token
 *  endpoint URL is capture-derived and can carry a tenant/session segment. The half
 *  that describes the GRANT is shape; the half that names a token endpoint is not. */
const PUBLISHED_OAUTH_PLAN_FIELDS: ReadonlySet<string> = new Set([
  "grant_type", "scopes",
]);

/** AuthTokenBinding says WHERE a token is found (cookie names, meta names, bundle
 *  regexes) — never the token. `token-resolver` needs it to re-mint on a foreign
 *  session, so it publishes; the shape is pinned so a future `observed_value`-style
 *  field cannot ride along. */
const PUBLISHED_AUTH_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "param_name", "param_location", "sources", "refresh_on_401",
]);
const PUBLISHED_AUTH_TOKEN_SOURCE_FIELDS: ReadonlySet<string> = new Set([
  "kind", "cookie_names", "meta_name", "meta_attr",
  "inline_script_regex", "bundle_url_pattern", "bundle_regex",
]);

/** EndpointConstraint minus `message`. `message` is the API's own error text copied
 *  verbatim (`source: "api_error"`), and APIs routinely echo the offending value back
 *  — including a token — inside it. `param` + `rule` is the machine-usable part and
 *  the only part anything reads; the prose is the part that carries the leak. */
const PUBLISHED_CONSTRAINT_FIELDS: ReadonlySet<string> = new Set([
  "param", "rule", "source", "learned_at",
]);

/** EndpointAnnotation: agent-authored prose, published on purpose, scrubbed anyway. */
const PUBLISHED_ANNOTATION_FIELDS: ReadonlySet<string> = new Set([
  "text", "agent_id", "created_at",
]);

/** Order-preserving allowlist filter. Iterating the INPUT's own keys (rather than the
 *  allowlist) keeps published key order byte-stable against the server-side port —
 *  `backend/tests/sanitize-parity.test.ts` compares the two by JSON.stringify. */
function pickPublished<T extends object>(value: T, allowed: ReadonlySet<string>): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    out[key] = entry;
  }
  return out as T;
}

function sanitizePublishedRouteTemplate(
  value: string,
  pathParams?: Record<string, unknown>,
): string {
  try {
    const parsed = new URL(value);
    let pathname = parsed.pathname;
    for (const [name, raw] of Object.entries(pathParams ?? {})) {
      if (raw == null || raw === "") continue;
      const placeholder = `{${name.replace(/[^A-Za-z0-9_]/g, "_") || "param"}}`;
      for (const candidate of [String(raw), encodeURIComponent(String(raw))]) {
        pathname = pathname.split(candidate).join(placeholder);
      }
    }
    let dynamicIndex = 0;
    pathname = pathname.split("/").map((segment) => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* keep encoded */ }
      if (/^\{[A-Za-z0-9_]+\}$/.test(decoded)) return decoded;
      if (
        /@/.test(decoded)
        || /^[0-9]{4,}$/.test(decoded)
        || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(decoded)
        || /^[A-Za-z0-9_-]{24,}$/.test(decoded)
      ) return `{path_${++dynamicIndex}}`;
      return segment;
    }).join("/");
    const query = [...parsed.searchParams.keys()].map((rawKey) => {
      const key = rawKey.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "param";
      return `${encodeURIComponent(key)}={${key.replace(/[^A-Za-z0-9_]/g, "_")}}`;
    });
    return `${parsed.origin}${pathname}${query.length ? `?${query.join("&")}` : ""}`;
  } catch {
    // Invalid or relative captured URLs are not safe remote route identities.
    return "";
  }
}

export function sanitizeForPublish(endpoints: EndpointDescriptor[]): EndpointDescriptor[] {
  return endpoints.map((endpoint) => {
    // ALLOWLIST, not a copy. Everything not named in PUBLISHED_ENDPOINT_FIELDS —
    // headers_template, _minedTemplate, _path_binding_candidates, and every field
    // added after this line was written — is already gone by construction.
    const clean = pickPublished(endpoint, PUBLISHED_ENDPOINT_FIELDS);
    if (typeof clean.url_template === "string") {
      clean.url_template = sanitizePublishedRouteTemplate(clean.url_template, endpoint.path_params);
    }

    // proven_recipe.headers is a SECOND COPY of those same captured headers, and deleting
    // only headers_template left the copy on the wire. Upstream (`pickReplayHeaders`) filters
    // it by a fixed header-NAME denylist — cookie / authorization / x-csrf-* — so a
    // site-specific auth header survives it, survives capture obfuscation (its name matches
    // no SECRET_KEY_PATTERN and its value no SECRET_VALUE_PATTERN), and reached the public
    // index verbatim. The denylist is the bug: the boundary cannot enumerate every site's
    // credential shape, so it must refuse the whole field rather than guess. proven_recipe.body
    // is likewise the raw captured request body while `body`/`body_params` are both
    // synthesized. Publishing them is not merely unsafe, it is useless: a foreign agent
    // replays with ITS OWN credentials from ITS OWN vault. The replay SHAPE — method,
    // url_template, response_signal — is the part a reader actually needs, so it stays.
    if (clean.proven_recipe) {
      const { headers: _headers, body: recipeBody, ...recipeShape } = clean.proven_recipe;
      clean.proven_recipe = {
        ...recipeShape,
        // ALL header values refused — not a name denylist. A foreign agent
        // replays with its own vault; captured Accept/Content-Type are free
        // to rediscover. Empty map keeps shape for older readers.
        headers: {},
        ...(recipeBody !== undefined ? { body: synthesizeExample(recipeBody) } : {}),
      };
    }

    // ws_messages[].data is a raw captured frame — the live socket's auth handshake and
    // per-user payloads, verbatim, with nothing between it and the index. Same treatment
    // `body` gets: keep the frame's shape, replace its contents.
    if (clean.ws_messages) {
      clean.ws_messages = clean.ws_messages.map((message) => ({
        ...message,
        data: synthesizeWireText(message.data),
      }));
    }

    // Auth MECHANISM survives at pinned shape; auth VALUES never existed here. Each
    // sub-allowlist is the same refusal one level down: a key added upstream to any of
    // these types does not reach the index until someone adds it to the list.
    if (clean.csrf_plan) {
      clean.csrf_plan = pickPublished(clean.csrf_plan, PUBLISHED_CSRF_PLAN_FIELDS);
    }
    if (clean.oauth_plan) {
      clean.oauth_plan = pickPublished(clean.oauth_plan, PUBLISHED_OAUTH_PLAN_FIELDS);
    }
    if (clean.auth_tokens) {
      clean.auth_tokens = clean.auth_tokens.map((binding) => {
        const kept = pickPublished(binding, PUBLISHED_AUTH_TOKEN_FIELDS);
        if (kept.sources) {
          kept.sources = kept.sources.map((source) =>
            pickPublished(source, PUBLISHED_AUTH_TOKEN_SOURCE_FIELDS));
        }
        return kept;
      });
    }

    // A learned constraint publishes its RULE, not the API's sentence. `message` is
    // copied verbatim out of an error response and an error response is one of the
    // likeliest places for a service to echo the offending token back at you.
    if (clean.constraints) {
      clean.constraints = clean.constraints.map((constraint) =>
        pickPublished(constraint, PUBLISHED_CONSTRAINT_FIELDS));
    }

    if (clean.annotations) {
      clean.annotations = clean.annotations.map((annotation) => {
        const kept = pickPublished(annotation, PUBLISHED_ANNOTATION_FIELDS);
        if (typeof kept.text === "string") kept.text = sanitizeAgentVisibleText(kept.text);
        return kept;
      });
    }

    // Free text written by a model that READ the real response. `sanitizeForPublish`
    // walks JSON values, not prose, so a token/phone/email in a description used to
    // ship untouched (see backend/tests/llm-scrub-residual.test.ts, which pins that
    // gap). Prose is allowlisted, then scrubbed — never published verbatim.
    if (typeof clean.description === "string") {
      clean.description = sanitizeAgentVisibleText(clean.description);
    }

    if (clean.query) {
      clean.query = redactSecrets(clean.query) as Record<string, unknown>;
    }
    if (clean.body) {
      clean.body = redactSecrets(clean.body) as Record<string, unknown>;
    }
    if (clean.query) {
      // Placeholder EVERY query value, not just strings. A numeric query value
      // (e.g. ?otp=654321, ?pin=123456) is the real input and previously passed
      // through unredacted — a cleartext leak for a sensitive numeric param.
      // Strings → "example"; numbers/booleans → synthesizePlaceholder (12345/…).
      clean.query = Object.fromEntries(
        Object.entries(clean.query).map(([key, value]) => [
          key,
          typeof value === "string" ? "example" : synthesizePlaceholder(key, value),
        ]),
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
      const semantic = pickPublished(clean.semantic, PUBLISHED_SEMANTIC_FIELDS);
      for (const field of SEMANTIC_PROSE_FIELDS) {
        const text = semantic[field];
        if (typeof text === "string") semantic[field] = sanitizeAgentVisibleText(text);
      }
      if (semantic.example_response_compact) {
        semantic.example_response_compact = synthesizeExample(semantic.example_response_compact);
      }
      if (semantic.example_request) {
        semantic.example_request = synthesizeExample(semantic.example_request);
        stripAllHeaderMapsInPlace(semantic.example_request);
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
      if (semantic.requires) semantic.requires = semantic.requires.map(stripBindingExample);
      if (semantic.provides) semantic.provides = semantic.provides.map(stripBindingExample);
      clean.semantic = semantic;
    }

    // Structural last pass: empty EVERY nested headers / headers_template /
    // *_headers map (index + /v1/graph/* wire). Site-specific session headers
    // are not special-cased by name.
    stripAllHeaderMapsInPlace(clean);

    return clean;
  });
}

/** A binding's example_value is normally a real captured value → strip it before
 *  publish (privacy). EXCEPTION: a sha256 commitment (`sha256:…`) is NOT a value —
 *  it is the censored stand-in a write's sensitive input was reduced to. Keeping it
 *  lets a published write route stay VERIFIABLE: a replaying agent supplies its own
 *  value and checks it against the commitment, without the secret ever being shared. */
function stripBindingExample(binding: OperationBinding): OperationBinding {
  if (typeof binding.example_value === "string" && binding.example_value.startsWith("sha256:")) {
    return binding; // keep the commitment
  }
  const { example_value: _exampleValue, ...rest } = binding;
  return rest;
}

// ---------------------------------------------------------------------------
// The MANIFEST boundary.
//
// `sanitizeForPublish` only ever saw `draft.endpoints`. A SkillManifest also carries
// `operation_graph`, and an operation node is a second, unsanitized copy of the same
// captured material: `example_response_compact` and `requires[].example_value` come
// straight from the capture, and `page_metadata.localStorage` is the page's REAL
// localStorage — which is where a great many sites park the access token.
//
// Nothing stripped it. `enforcePublishSanitization` on the server re-scrubs
// `body.endpoints` and only `body.endpoints`, so the graph reached the public index
// verbatim through both the client and the server boundary.
//
// A foreign agent could not use those values even if we published them — it replays
// against its OWN session — so there is nothing to trade off here. The keys are not
// kept either: a localStorage key can itself be user-scoped (`user:1234:profile`).
// ---------------------------------------------------------------------------

/** Fields permitted to leave on a published operation node. */
const PUBLISHED_OPERATION_FIELDS: ReadonlySet<string> = new Set([
  "operation_id", "endpoint_id", "method", "url_template", "trigger_url",
  "action_kind", "resource_kind",
  "description_in", "description_out", "response_summary",
  "requires", "provides", "negative_tags",
  "example_request", "example_response_compact", "example_fields",
  "confidence", "observed_at", "auth_required", "page_metadata",
]);

/** Operation-node prose, scrubbed exactly as `semantic`'s is. */
const OPERATION_PROSE_FIELDS = ["description_in", "description_out", "response_summary"] as const;

/** `page_metadata` publishes WHEN it was captured and nothing else. `localStorage` is
 *  raw captured storage (access tokens live there) and `embedded_json` is the page's
 *  own SSR payload (the logged-in user's data). Both are refused by omission. */
const PUBLISHED_PAGE_METADATA_FIELDS: ReadonlySet<string> = new Set(["captured_at"]);

/** Sanitize one operation-graph node. Same rules as an endpoint's `semantic`: the
 *  shape survives, the captured values do not. */
export function sanitizeOperationNodeForPublish(node: SkillOperationNode): SkillOperationNode {
  const clean = pickPublished(node, PUBLISHED_OPERATION_FIELDS);
  if (typeof clean.url_template === "string") {
    clean.url_template = sanitizePublishedRouteTemplate(clean.url_template);
  }

  for (const field of OPERATION_PROSE_FIELDS) {
    const text = clean[field];
    if (typeof text === "string") clean[field] = sanitizeAgentVisibleText(text);
  }
  if (clean.example_response_compact) {
    clean.example_response_compact = synthesizeExample(clean.example_response_compact);
  }
  if (clean.example_request) {
    clean.example_request = synthesizeExample(clean.example_request);
    // Nested headers under example_request must never carry values to /v1/graph/* or index.
    stripAllHeaderMapsInPlace(clean.example_request);
  }
  if (clean.requires) clean.requires = clean.requires.map(stripBindingExample);
  if (clean.provides) clean.provides = clean.provides.map(stripBindingExample);
  if (clean.trigger_url) {
    try {
      const parsed = new URL(clean.trigger_url);
      clean.trigger_url = parsed.origin + parsed.pathname;
    } catch {
      /* keep original */
    }
  }
  if (clean.page_metadata) {
    clean.page_metadata = pickPublished(clean.page_metadata, PUBLISHED_PAGE_METADATA_FIELDS);
  }
  stripAllHeaderMapsInPlace(clean);
  return clean;
}

const PUBLISHED_GRAPH_FIELDS: ReadonlySet<string> = new Set([
  "generated_at", "entry_operation_ids", "operations", "edges",
]);
const PUBLISHED_EDGE_FIELDS: ReadonlySet<string> = new Set([
  "edge_id", "from_operation_id", "to_operation_id", "binding_key", "kind", "confidence",
]);

export function sanitizeOperationGraphForPublish(graph: SkillOperationGraph): SkillOperationGraph {
  const clean = pickPublished(graph, PUBLISHED_GRAPH_FIELDS);
  clean.entry_operation_ids = (graph.entry_operation_ids ?? []).map((value) => sanitizeAgentVisibleText(value));
  clean.operations = (graph.operations ?? []).map(sanitizeOperationNodeForPublish);
  clean.edges = (graph.edges ?? []).map((edge) => {
    const safe = pickPublished(edge, PUBLISHED_EDGE_FIELDS);
    for (const key of ["edge_id", "from_operation_id", "to_operation_id", "binding_key", "kind"] as const) {
      const value = safe[key];
      if (typeof value === "string") (safe as unknown as Record<string, unknown>)[key] = sanitizeAgentVisibleText(value);
    }
    return safe;
  });
  return clean;
}

/**
 * The credential/PII boundary for a WHOLE manifest. Top-level fields are an
 * allowlist: future capture metadata is local unless deliberately reviewed.
 */
export function sanitizeManifestForPublish<
  T extends { endpoints?: EndpointDescriptor[]; operation_graph?: SkillOperationGraph },
>(manifest: T): T {
  const source = manifest as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  const scalarKeys = [
    "skill_id", "version", "schema_version", "domain", "subdomain",
    "owner_type", "execution_type", "lifecycle", "created_at", "updated_at",
    "prev_version", "indexer_id", "split_config", "base_price_usd",
    "owner_compensation_opt_in", "markup_bps", "reviewed_at", "visibility",
  ] as const;
  for (const key of scalarKeys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") clean[key] = value;
  }
  for (const key of ["name", "intent_signature", "description", "changelog"] as const) {
    if (typeof source[key] === "string") clean[key] = sanitizeAgentVisibleText(source[key] as string);
  }
  if (Array.isArray(source.intents)) {
    clean.intents = source.intents
      .filter((value): value is string => typeof value === "string")
      .slice(0, 100)
      .map(sanitizeAgentVisibleText);
  }
  if (typeof source.auth_profile_ref === "string" && /^auth:[A-Za-z0-9_.:-]{1,200}$/.test(source.auth_profile_ref)) {
    clean.auth_profile_ref = source.auth_profile_ref;
  }
  if (Array.isArray(manifest.endpoints)) clean.endpoints = sanitizeForPublish(manifest.endpoints);
  if (manifest.operation_graph) clean.operation_graph = sanitizeOperationGraphForPublish(manifest.operation_graph);
  return clean as T;
}

/**
 * Structural: is this key an HTTP header *map* (object of name→value)?
 * Not a denylist of header names — any map called headers* is refused on the
 * public index / graph wire. Site-specific session headers (x-wk-session, …)
 * are the failure mode a name denylist always misses.
 */
export function isHeaderMapKey(key: string): boolean {
  const k = key.trim();
  return (
    /^(headers|headers_template|request_headers|response_headers)$/i.test(k)
    || /_headers$/i.test(k)
  );
}

/** Placeholder values allowed under header maps (empty map preferred). */
function isHeaderPlaceholder(value: string): boolean {
  return value === "" || value === "[REDACTED]" || value === "example" || value === "[secret-token]";
}

/**
 * In-place: empty every nested header map. Used by sanitize* so the public
 * index and POST /v1/graph/* never receive captured request headers.
 */
export function stripAllHeaderMapsInPlace(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) stripAllHeaderMapsInPlace(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (isHeaderMapKey(key) && value != null && typeof value === "object" && !Array.isArray(value)) {
      obj[key] = {};
      continue;
    }
    stripAllHeaderMapsInPlace(value);
  }
}

/**
 * Last-line seal before any payload leaves the client toward the public index,
 * marketplace, or graph ingest. Walks every string leaf; refuses (throws) if a
 * secret-shaped value or ANY non-empty header-map value survives sanitization.
 *
 * Structural (not a per-site list):
 *   - looksLikeSecret(key, value)
 *   - any value under a headers / headers_template / *_headers map
 *   - cookie / authorization field names even outside a map (transport leak)
 */
const FORBIDDEN_WIRE_HEADER_NAMES =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-?key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|authentication)$/i;

export type WireSecretHit = {
  path: string;
  reason: "secret_key" | "secret_value" | "forbidden_header_value" | "header_map_value";
  preview: string;
};

export function findWireSecretHits(payload: unknown, path = "$"): WireSecretHit[] {
  const hits: WireSecretHit[] = [];
  const walk = (node: unknown, p: string, parentKey = "", underHeaderMap = false): void => {
    if (node == null) return;
    if (typeof node === "string") {
      if (underHeaderMap && node.length > 0 && !isHeaderPlaceholder(node)) {
        hits.push({
          path: p,
          reason: "header_map_value",
          preview: node.slice(0, 12) + (node.length > 12 ? "…" : ""),
        });
        return;
      }
      if (looksLikeSecret(parentKey, node)) {
        hits.push({
          path: p,
          reason: SECRET_KEY_PATTERNS.test(parentKey) ? "secret_key" : "secret_value",
          preview: node.slice(0, 12) + (node.length > 12 ? "…" : ""),
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${p}[${i}]`, parentKey, underHeaderMap));
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const childPath = `${p}.${key}`;
        const nextUnderHeaders = underHeaderMap || isHeaderMapKey(key);
        // Transport header field names outside a map still forbidden with values.
        if (
          !nextUnderHeaders
          && FORBIDDEN_WIRE_HEADER_NAMES.test(key)
          && typeof value === "string"
          && value.length > 0
          && !isHeaderPlaceholder(value)
        ) {
          hits.push({
            path: childPath,
            reason: "forbidden_header_value",
            preview: value.slice(0, 12) + (value.length > 12 ? "…" : ""),
          });
          continue;
        }
        walk(value, childPath, key, nextUnderHeaders);
      }
    }
  };
  walk(payload, path);
  return hits;
}

/** Throws if payload still carries secret-shaped leaves or header values. */
export function assertWirePayloadClean(payload: unknown, context = "publish"): void {
  const hits = findWireSecretHits(payload);
  if (hits.length === 0) return;
  const sample = hits.slice(0, 5).map((h) => `${h.path} (${h.reason})`).join("; ");
  throw new Error(
    `[secret-seal] refused ${context}: ${hits.length} secret-shaped leaf(ves) would leave the client. ` +
      `Sample: ${sample}. All HTTP header maps must be empty on the index/graph wire; ` +
      `use sanitizeManifestForPublish before POST.`,
  );
}
