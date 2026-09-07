/**
 * The credential boundary at publish.
 *
 * `unbrowse build publish --skill <id> --confirm-publish` POSTs a SkillManifest draft to
 * `/v1/skills`. `sanitizeForPublish` (src/publish/sanitize.ts) is the ONLY thing standing
 * between a real browsing capture and the public index. This file asserts the two halves
 * of that boundary, and they pull in opposite directions:
 *
 *   1. NOTHING the user's session produced may appear in the published payload.
 *   2. EVERYTHING that makes the route replayable — path, method, param names, response
 *      shape — must survive. A sanitizer that redacts the structure has broken the
 *      product just as badly, only quietly.
 *
 * The adversary here is not a JWT. `looksLikeSecret` is a DENYLIST OF SHAPES:
 * SECRET_KEY_PATTERNS matches key names (`api_key`, `session_id`), SECRET_VALUE_PATTERNS
 * matches value shapes (`eyJ…`, `sk-`, `ghp_`, `AKIA…`). A site-specific session cookie
 * whose name is a base64-ish site token and whose value is 24 chars of lowercase hex is on
 * neither list — `looksLikeSecret` returns FALSE for it. The boundary must therefore hold
 * WITHOUT the denylist ever firing, which is exactly what these tests pin.
 *
 * Every credential below is SYNTHETIC.
 */
import { describe, expect, it } from "bun:test";
import { looksLikeSecret, sanitizeForPublish } from "../src/publish/sanitize.js";
import type { EndpointDescriptor } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// The synthetic adversary: a site-specific session credential that no pattern matches.
// ---------------------------------------------------------------------------

/** Base64-ish, site-specific cookie/header NAME. Matches no SECRET_KEY_PATTERN. */
const SESSION_NAME = "IndrX1dCQXZ4aW5XXzdnZ2luMVhqVkdwcXRRQ1lVUGFz";
/** 24 chars of lowercase hex. Matches no SECRET_VALUE_PATTERN (the base64 rule needs 40+). */
const SESSION_VALUE = "9f3c1a7b2e4d6058ac91bd73";
/** A second synthetic secret, in a shape the denylist DOES know, as the control. */
const KNOWN_SHAPE_SECRET = "sk-testonly000000000000000000";

/** Every synthetic credential value that must not survive to the index. */
const CREDENTIALS = [SESSION_VALUE, KNOWN_SHAPE_SECRET];

function serialized(endpoint: EndpointDescriptor): string {
  return JSON.stringify(endpoint);
}

/**
 * An endpoint as a real authenticated capture leaves it, with the synthetic session
 * credential in every place a capture actually puts one. This is the payload that would
 * be handed to `publishSkill` → `POST /v1/skills`.
 */
function capturedEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep-feed-1",
    method: "POST",
    url_template: "https://api.site.test/v2/users/{user_id}/feed?cursor={cursor}",
    description: "Fetch a user's feed page",
    // Captured request headers — the cookie jar, verbatim.
    headers_template: {
      cookie: `${SESSION_NAME}=${SESSION_VALUE}`,
      "x-wk-session": SESSION_VALUE,
      accept: "application/json",
    },
    query: { cursor: "eyJvIjoyMH0", [SESSION_NAME]: SESSION_VALUE },
    path_params: { user_id: "8812734" },
    body: { filter: "recent", auth_ctx: SESSION_VALUE, note: "my private note" },
    body_params: { filter: "recent" },
    trigger_url: `https://site.test/u/8812734/feed?${SESSION_NAME}=${SESSION_VALUE}`,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    // Phase 7.2 proven_recipe: built upstream by `buildProvenRecipe`, whose
    // `pickReplayHeaders` drops cookie/authorization/x-csrf-* by NAME — and keeps
    // everything else, including a site-specific auth header.
    proven_recipe: {
      method: "POST",
      url_template: "https://api.site.test/v2/users/{user_id}/feed",
      headers: {
        "x-wk-session": SESSION_VALUE,
        "x-site-token": KNOWN_SHAPE_SECRET,
        accept: "application/json",
      },
      body: { filter: "recent", auth_ctx: SESSION_VALUE },
      response_signal: { status: 200, content_type: "application/json", json_top_keys: ["items", "next"] },
    },
    // Raw captured socket frames.
    ws_messages: [
      { direction: "sent", data: `{"op":"subscribe","token":"${SESSION_VALUE}","channel":"feed"}`, timestamp: "2026-01-01T00:00:00Z" },
      { direction: "received", data: `raw-frame-${SESSION_VALUE}`, timestamp: "2026-01-01T00:00:01Z" },
    ],
    // Internal capture annotation: the real path segment a placeholder replaced.
    _path_binding_candidates: [
      { placeholder: "{user_id}", observed_value: "8812734", segment_index: 3, source: "context_diff" },
      { placeholder: "{sess}", observed_value: SESSION_VALUE, segment_index: 4, source: "context_diff" },
    ],
    _minedTemplate: `https://api.site.test/v2/users/8812734/feed?${SESSION_NAME}=${SESSION_VALUE}`,
    semantic: {
      action_kind: "read",
      resource_kind: "feed_item",
      description_in: "Requires a user_id and a cursor",
      description_out: "Returns the user's feed items, newest first",
      response_summary: "items[].id, items[].text, items[].created_at, next",
      example_fields: ["items[].id", "items[].text", "next"],
      example_request: { filter: "recent", auth_ctx: SESSION_VALUE },
      example_response_compact: {
        items: [{ id: 991, text: "my private post", author_email: "me@private.test" }],
        next: SESSION_VALUE,
      },
      sample_request_url: `https://api.site.test/v2/users/8812734/feed?${SESSION_NAME}=${SESSION_VALUE}`,
      requires: [{ key: "cursor", required: true, source: "query", semantic_type: "pagination_cursor", example_value: SESSION_VALUE }],
      provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier", example_value: "991" }],
      auth_required: true,
      confidence: 0.9,
    },
    ...overrides,
  } as EndpointDescriptor;
}

// ---------------------------------------------------------------------------
// 0. Why the denylist cannot be the boundary.
// ---------------------------------------------------------------------------

describe("the shape denylist misses site-specific session credentials", () => {
  it("looksLikeSecret is FALSE for a site-specific session name + 24-hex value", () => {
    // If this ever flips to true, the denylist grew — good, but it does not change the
    // rule below, which is that the boundary must not DEPEND on this returning true.
    expect(looksLikeSecret(SESSION_NAME, SESSION_VALUE)).toBe(false);
    expect(looksLikeSecret("x-wk-session", SESSION_VALUE)).toBe(false);
    expect(looksLikeSecret("cookie", `${SESSION_NAME}=${SESSION_VALUE}`)).toBe(false);
  });

  it("looksLikeSecret IS true for the known shapes — so the miss above is about coverage, not a broken matcher", () => {
    expect(looksLikeSecret("x-site-token", KNOWN_SHAPE_SECRET)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. Direction one: no credential reaches the index.
// ---------------------------------------------------------------------------

describe("credentials never reach the public index", () => {
  it("the synthetic session credential appears NOWHERE in the published endpoint", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    const payload = serialized(clean!);
    for (const credential of CREDENTIALS) {
      expect(payload).not.toContain(credential);
    }
  });

  it("headers_template is gone — not emptied, gone", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.headers_template).toBeUndefined();
  });

  it("proven_recipe carries no captured headers — the second copy of the cookie jar", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    // The site-specific header name is NOT on pickReplayHeaders' denylist upstream, so
    // the boundary must refuse the whole field rather than trust the name filter.
    expect(clean!.proven_recipe?.headers).toEqual({});
    expect(JSON.stringify(clean!.proven_recipe)).not.toContain(SESSION_VALUE);
    expect(JSON.stringify(clean!.proven_recipe)).not.toContain(KNOWN_SHAPE_SECRET);
  });

  it("proven_recipe.body is synthesized, not the captured request body", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    const body = clean!.proven_recipe?.body as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(body.auth_ctx).toBeDefined();          // the KEY is shape — it stays
    expect(body.auth_ctx).not.toBe(SESSION_VALUE); // the VALUE is a credential — it goes
  });

  it("ws_messages carry no captured frame contents", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(JSON.stringify(clean!.ws_messages)).not.toContain(SESSION_VALUE);
  });

  it("internal capture annotations are dropped — they hold the pre-templatisation values", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]) as Array<
      EndpointDescriptor & { _minedTemplate?: string; _path_binding_candidates?: unknown }
    >;
    expect(clean!._path_binding_candidates).toBeUndefined();
    expect(clean!._minedTemplate).toBeUndefined();
  });

  it("query and path_param VALUES are placeholders regardless of the denylist", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    // A blanket placeholder is what makes this safe. If anyone ever "optimises" this to
    // redact only `looksLikeSecret` matches, SESSION_VALUE walks straight through — the
    // test above proves the matcher says false for it.
    expect(Object.values(clean!.query ?? {})).toEqual(["example", "example"]);
    expect(Object.values(clean!.path_params ?? {})).toEqual(["example"]);
  });

  it("trigger_url and sample_request_url shed their captured query values", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.trigger_url).toBe("https://site.test/u/8812734/feed");
    expect(clean!.semantic?.sample_request_url).not.toContain(SESSION_VALUE);
  });

  it("binding example_values and response examples are synthesized", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.semantic?.requires?.[0]?.example_value).toBeUndefined();
    const example = clean!.semantic?.example_response_compact as Record<string, unknown>;
    expect(example.next).not.toBe(SESSION_VALUE);
    const item = (example.items as Record<string, unknown>[])[0]!;
    expect(item.text).not.toBe("my private post");
    expect(item.author_email).toBe("user@example.com");
  });
});

// ---------------------------------------------------------------------------
// 2. Direction two: the SKILL survives. A sanitizer that eats the structure has
//    broken the product in the other direction, and nothing else would notice.
// ---------------------------------------------------------------------------

describe("the skill survives sanitization", () => {
  it("route identity is untouched: method, path template, placeholders", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.method).toBe("POST");
    expect(clean!.url_template).toBe("https://api.site.test/v2/users/{user_id}/feed?cursor={cursor}");
    expect(clean!.endpoint_id).toBe("ep-feed-1");
    expect(clean!.description).toBe("Fetch a user's feed page");
  });

  it("parameter NAMES survive everywhere — names are the shape, values are the secret", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(Object.keys(clean!.query ?? {}).sort()).toEqual([SESSION_NAME, "cursor"].sort());
    expect(Object.keys(clean!.path_params ?? {})).toEqual(["user_id"]);
    expect(Object.keys(clean!.body ?? {}).sort()).toEqual(["auth_ctx", "filter", "note"]);
  });

  it("response shape survives: keys, nesting, and types", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    const example = clean!.semantic?.example_response_compact as Record<string, unknown>;
    expect(Object.keys(example).sort()).toEqual(["items", "next"]);
    expect(Array.isArray(example.items)).toBe(true);
    const item = (example.items as Record<string, unknown>[])[0]!;
    expect(Object.keys(item).sort()).toEqual(["author_email", "id", "text"]);
    expect(typeof item.id).toBe("number");
  });

  it("semantic routing metadata survives — this is what makes a skill findable", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.semantic?.action_kind).toBe("read");
    expect(clean!.semantic?.resource_kind).toBe("feed_item");
    expect(clean!.semantic?.description_out).toBe("Returns the user's feed items, newest first");
    expect(clean!.semantic?.response_summary).toBe("items[].id, items[].text, items[].created_at, next");
    expect(clean!.semantic?.example_fields).toEqual(["items[].id", "items[].text", "next"]);
    expect(clean!.semantic?.auth_required).toBe(true);
    expect(clean!.semantic?.requires?.[0]?.key).toBe("cursor");
    expect(clean!.semantic?.requires?.[0]?.semantic_type).toBe("pagination_cursor");
    expect(clean!.semantic?.provides?.[0]?.key).toBe("item_id");
  });

  it("proven_recipe keeps the replay SHAPE it is useful for", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.proven_recipe?.method).toBe("POST");
    expect(clean!.proven_recipe?.url_template).toBe("https://api.site.test/v2/users/{user_id}/feed");
    expect(clean!.proven_recipe?.response_signal.status).toBe(200);
    expect(clean!.proven_recipe?.response_signal.json_top_keys).toEqual(["items", "next"]);
  });

  it("ws_messages keep their direction and frame shape", () => {
    const [clean] = sanitizeForPublish([capturedEndpoint()]);
    expect(clean!.ws_messages?.[0]?.direction).toBe("sent");
    const frame = JSON.parse(clean!.ws_messages![0]!.data) as Record<string, unknown>;
    expect(Object.keys(frame).sort()).toEqual(["channel", "op", "token"]);
  });

  it("does not mutate the caller's endpoint — the local copy keeps working", () => {
    const original = capturedEndpoint();
    sanitizeForPublish([original]);
    expect(original.headers_template?.["x-wk-session"]).toBe(SESSION_VALUE);
    expect(original.proven_recipe?.headers["x-wk-session"]).toBe(SESSION_VALUE);
  });
});
