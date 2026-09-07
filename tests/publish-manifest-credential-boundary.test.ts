/**
 * The credential boundary at the MANIFEST level, and the allowlist shape underneath it.
 *
 * `tests/publish-credential-boundary.test.ts` pins the endpoint half. This file pins the
 * two things that half could not see:
 *
 *   1. **A manifest is more than its endpoints.** `publishSkill` sanitizes
 *      `draft.endpoints` and nothing else, and the server's re-scrub
 *      (`enforcePublishSanitization`) re-scrubs `body.endpoints` and nothing else. So
 *      `operation_graph[].page_metadata.localStorage` — the page's REAL localStorage,
 *      which is where a large number of sites park the access token — had no boundary
 *      between it and the public index on either side. Same for the operation node's
 *      `example_response_compact` and `requires[].example_value`, which are a second
 *      copy of the captured response and the captured input.
 *
 *   2. **The endpoint sanitizer is an allowlist, not a denylist.** It used to be
 *      `{ ...endpoint }` minus a handful of known-bad keys, which publishes every field
 *      anyone adds later, by default. That shape had already leaked once (`proven_recipe`
 *      carried a second copy of the captured auth headers). The test that matters here is
 *      not "field X is gone" — a denylist can pass that by naming X. It is "a field this
 *      file has never heard of is gone", which only an allowlist can pass.
 *
 * VACUITY GUARD. Every "the secret is absent" assertion in this file runs through
 * `sanitizedWithGuard()`, which first asserts (a) each secret really is present in the
 * INPUT, (b) the input manifest is non-empty and its operation graph is non-empty and
 * really carries localStorage, and (c) the OUTPUT is still a non-empty manifest with the
 * same endpoint and operation counts. "No token in the output" is trivially true of an
 * empty output; the guard makes that impossible to pass silently.
 *
 * Every credential here is SYNTHETIC and every host is an RFC-2606 `.invalid` name.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  sanitizeForPublish,
  sanitizeManifestForPublish,
  sanitizeOperationGraphForPublish,
  sanitizeOperationNodeForPublish,
} from "../src/publish/sanitize.js";
import { buildSkillOperationGraph } from "../src/lib/graph-core/index.js";
import type {
  EndpointDescriptor,
  SkillManifest,
  SkillOperationNode,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Synthetic credentials. None of these is on `looksLikeSecret`'s shape denylist
// except where noted — the boundary must hold without the matcher firing.
// ---------------------------------------------------------------------------

/** A site's access token as it actually sits in localStorage. */
const LS_ACCESS_TOKEN = "at-7f19c04b2ad6438e9c115fbe0d72aa31";
/** The localStorage KEY, which is itself user-scoped — keys are not shape here. */
const LS_USER_SCOPED_KEY = "user:88127340:session";
/** A value from the page's own SSR payload. */
const EMBEDDED_JSON_VALUE = "private-household-address-14b";
/** A captured value on an operation node's example response. */
const OP_RESPONSE_VALUE = "my private draft post";
/** A captured input value on an operation binding. */
const OP_BINDING_VALUE = "5b1e9d0c7a3f4826";
/** An OAuth token endpoint, capture-derived and tenant-scoped. */
const OAUTH_TOKEN_URL = "https://login.example.invalid/tenant-88127340/oauth2/token";
/** An API error message that echoed the offending credential straight back. */
const CONSTRAINT_ECHO = `Invalid value for auth_ctx: '${LS_ACCESS_TOKEN}' is expired`;
/** A real-shaped phone number in model-written prose. The endpoint sanitizer walks JSON
 *  values, not prose, so this shipped verbatim — see backend/tests/llm-scrub-residual.test.ts,
 *  which pins that exact gap on the server port. */
const PROSE_PHONE = "+1-415-555-0123";
/** A field name that does not exist on EndpointDescriptor. Stands in for "the next field
 *  someone adds". A denylist cannot possibly name it; an allowlist drops it by default. */
const FUTURE_FIELD = "capture_debug_blob";
const FUTURE_FIELD_VALUE = `debug:${LS_ACCESS_TOKEN}`;

/** Every synthetic secret that must not survive to the public index. */
const SECRETS = [
  LS_ACCESS_TOKEN,
  LS_USER_SCOPED_KEY,
  EMBEDDED_JSON_VALUE,
  OP_RESPONSE_VALUE,
  OP_BINDING_VALUE,
  OAUTH_TOKEN_URL,
  CONSTRAINT_ECHO,
  PROSE_PHONE,
  FUTURE_FIELD_VALUE,
];

// ---------------------------------------------------------------------------
// The fixture: a manifest as a real authenticated capture leaves it.
// ---------------------------------------------------------------------------

function capturedEndpoint(): EndpointDescriptor {
  return {
    endpoint_id: "ep-feed-1",
    method: "POST",
    url_template: "https://api.example.invalid/graphql?queryId=feedDashMainFeed.9c1a",
    description: `Fetch the feed. Support line ${PROSE_PHONE}.`,
    query: { cursor: "0" },
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    // Auth MECHANISM. Names and enums — no captured value lives in any of these.
    csrf_plan: {
      source: "cookie",
      param_name: "x-csrf-token",
      refresh_on_401: true,
      extractor_sequence: ["JSESSIONID"],
    },
    oauth_plan: {
      grant_type: "authorization_code",
      token_url: OAUTH_TOKEN_URL,
      scopes: ["feed.read"],
      refresh_path: "/oauth2/refresh",
    },
    // Learned from a real 400. `message` is the API's own sentence, copied verbatim.
    constraints: [
      { param: "auth_ctx", rule: "required", message: CONSTRAINT_ECHO, source: "api_error", learned_at: "2026-01-01T00:00:00Z" },
    ],
    semantic: {
      action_kind: "read",
      resource_kind: "feed_item",
      description_out: `Returns feed items. Escalate to ${PROSE_PHONE} on repeated 403s.`,
      confidence: 0.9,
    },
    // The field nobody has written yet.
    [FUTURE_FIELD]: FUTURE_FIELD_VALUE,
  } as unknown as EndpointDescriptor;
}

function capturedOperationNode(): SkillOperationNode {
  return {
    operation_id: "op-feed-1",
    endpoint_id: "ep-feed-1",
    method: "POST",
    url_template: "https://api.example.invalid/graphql?queryId=feedDashMainFeed.9c1a",
    trigger_url: `https://www.example.invalid/feed?sess=${LS_ACCESS_TOKEN}`,
    action_kind: "read",
    resource_kind: "feed_item",
    description_out: `Returns the viewer's feed. Owner reachable at ${PROSE_PHONE}.`,
    requires: [
      { key: "cursor", required: true, source: "query", semantic_type: "pagination_cursor", example_value: OP_BINDING_VALUE },
    ],
    provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
    example_response_compact: { items: [{ id: 991, text: OP_RESPONSE_VALUE }] },
    confidence: 0.9,
    // The reason this file exists. Raw captured browser storage, plus the page's own
    // SSR payload, hanging off a node that no sanitizer ever opened.
    page_metadata: {
      localStorage: {
        access_token: LS_ACCESS_TOKEN,
        [LS_USER_SCOPED_KEY]: "1",
      },
      embedded_json: [{ viewer: { address: EMBEDDED_JSON_VALUE } }],
      captured_at: "2026-01-01T00:00:00Z",
    },
    // The field nobody has written yet, on the node this time.
    [FUTURE_FIELD]: FUTURE_FIELD_VALUE,
  } as unknown as SkillOperationNode;
}

function capturedManifest(): SkillManifest {
  return {
    skill_id: "sk-example-invalid",
    version: "1.0.0",
    schema_version: "1",
    name: "example.invalid feed",
    intent_signature: "read the feed",
    domain: "example.invalid",
    description: "Feed routes for example.invalid",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [capturedEndpoint()],
    lifecycle: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    operation_graph: {
      generated_at: "2026-01-01T00:00:00Z",
      entry_operation_ids: ["op-feed-1"],
      operations: [capturedOperationNode()],
      edges: [
        { edge_id: "e1", from_operation_id: "op-feed-1", to_operation_id: "op-feed-1", binding_key: "cursor", kind: "pagination", confidence: 0.8 },
      ],
    },
  } as unknown as SkillManifest;
}

// ---------------------------------------------------------------------------
// The vacuity guard. Nothing in this file asserts an absence without going
// through here first.
// ---------------------------------------------------------------------------

interface Guarded {
  raw: SkillManifest;
  clean: SkillManifest;
  cleanBlob: string;
  cleanGraphBlob: string;
}

function sanitizedWithGuard(): Guarded {
  const raw = capturedManifest();
  const rawBlob = JSON.stringify(raw);

  // (a) The INPUT really carries every secret. Without this, an "absent" assertion
  //     passes when the fixture silently stops containing the thing it names.
  for (const secret of SECRETS) {
    expect(rawBlob).toContain(secret);
  }

  // (b) The input is a real, non-empty manifest and the graph really carries storage.
  expect(raw.endpoints.length).toBeGreaterThan(0);
  expect(raw.operation_graph!.operations.length).toBeGreaterThan(0);
  const rawStorage = raw.operation_graph!.operations[0]!.page_metadata!.localStorage!;
  expect(Object.keys(rawStorage).length).toBeGreaterThan(0);
  expect(raw.operation_graph!.operations[0]!.page_metadata!.embedded_json!.length).toBeGreaterThan(0);

  const clean = sanitizeManifestForPublish(raw);
  const cleanBlob = JSON.stringify(clean);
  const cleanGraphBlob = JSON.stringify(clean.operation_graph);

  // (c) The OUTPUT is still a manifest. An empty object contains no secrets either.
  expect(clean.endpoints.length).toBe(raw.endpoints.length);
  expect(clean.operation_graph!.operations.length).toBe(raw.operation_graph!.operations.length);
  expect(clean.operation_graph!.edges.length).toBe(raw.operation_graph!.edges.length);
  expect(cleanBlob.length).toBeGreaterThan(400);
  expect(cleanGraphBlob.length).toBeGreaterThan(200);

  return { raw, clean, cleanBlob, cleanGraphBlob };
}

// ---------------------------------------------------------------------------
// 0. The guard itself must be load-bearing.
// ---------------------------------------------------------------------------

describe("vacuity guard", () => {
  it("the fixture is non-empty and every named secret is present in it before sanitization", () => {
    const { raw, clean } = sanitizedWithGuard();
    expect(raw.endpoints.length).toBe(1);
    expect(raw.operation_graph!.operations.length).toBe(1);
    // And the sanitizer is not the identity function — something actually changed.
    expect(JSON.stringify(clean)).not.toBe(JSON.stringify(raw));
  });

  it("sanitizeManifestForPublish does not mutate the caller's manifest — local replay needs it", () => {
    const raw = capturedManifest();
    sanitizeManifestForPublish(raw);
    // The LOCAL copy keeps the captured storage. Sanitizing in place would silently
    // break local replay while looking like a privacy win.
    expect(raw.operation_graph!.operations[0]!.page_metadata!.localStorage!.access_token)
      .toBe(LS_ACCESS_TOKEN);
    expect((raw.endpoints[0] as unknown as Record<string, unknown>)[FUTURE_FIELD])
      .toBe(FUTURE_FIELD_VALUE);
  });
});

// ---------------------------------------------------------------------------
// 1. The manifest-level refusal: captured page storage never reaches the index.
// ---------------------------------------------------------------------------

describe("operation_graph page_metadata is refused at publish", () => {
  it("page_metadata.localStorage is GONE — not emptied, not key-preserved, gone", () => {
    const { clean } = sanitizedWithGuard();
    const published = clean.operation_graph!.operations[0]!;
    expect(published.page_metadata).toBeDefined();
    expect(published.page_metadata!.localStorage).toBeUndefined();
  });

  it("no localStorage token or page_metadata key survives anywhere in the manifest", () => {
    const { cleanBlob } = sanitizedWithGuard();
    expect(cleanBlob).not.toContain(LS_ACCESS_TOKEN);
    // The KEY is not shape here either: `user:88127340:session` names the account.
    // NOTE the bound — this covers the page_metadata path only. The graph builder ALSO
    // promotes localStorage keys onto `provides[]`, where they survive on purpose; the
    // last describe in this file pins that separately rather than letting this
    // assertion imply a guarantee it does not make.
    expect(cleanBlob).not.toContain(LS_USER_SCOPED_KEY);
  });

  it("page_metadata.embedded_json is GONE — it is the logged-in user's own SSR payload", () => {
    const { clean, cleanBlob } = sanitizedWithGuard();
    expect(clean.operation_graph!.operations[0]!.page_metadata!.embedded_json).toBeUndefined();
    expect(cleanBlob).not.toContain(EMBEDDED_JSON_VALUE);
  });

  it("page_metadata.captured_at survives — provenance is not a credential", () => {
    const { clean } = sanitizedWithGuard();
    expect(clean.operation_graph!.operations[0]!.page_metadata!.captured_at)
      .toBe("2026-01-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// 2. The manifest-level refusal: an operation node is a SECOND copy of the capture.
// ---------------------------------------------------------------------------

describe("operation nodes are sanitized like endpoint semantics", () => {
  it("example_response_compact is synthesized, not the captured response", () => {
    const { clean, cleanGraphBlob } = sanitizedWithGuard();
    const example = clean.operation_graph!.operations[0]!.example_response_compact as Record<string, unknown>;
    expect(example).toBeDefined();
    expect(Object.keys(example)).toEqual(["items"]); // shape survives
    expect(cleanGraphBlob).not.toContain(OP_RESPONSE_VALUE);
  });

  it("requires[].example_value is stripped from the graph, as it is from semantic", () => {
    const { clean, cleanGraphBlob } = sanitizedWithGuard();
    const required = clean.operation_graph!.operations[0]!.requires[0]!;
    expect(required.key).toBe("cursor");             // the binding NAME is the shape
    expect(required.example_value).toBeUndefined();  // the captured value is not
    expect(cleanGraphBlob).not.toContain(OP_BINDING_VALUE);
  });

  it("a node's trigger_url sheds its captured query values", () => {
    const { clean } = sanitizedWithGuard();
    expect(clean.operation_graph!.operations[0]!.trigger_url)
      .toBe("https://www.example.invalid/feed");
  });

  it("model-written node prose is scrubbed, not published verbatim", () => {
    const { clean, cleanGraphBlob } = sanitizedWithGuard();
    expect(cleanGraphBlob).not.toContain(PROSE_PHONE);
    // The sentence still reads — only the real-shaped number is replaced.
    expect(clean.operation_graph!.operations[0]!.description_out).toContain("Returns the viewer's feed");
  });
});

// ---------------------------------------------------------------------------
// 3. The allowlist SHAPE. This is the structural claim: a field this file has
//    never heard of does not reach the index. A denylist cannot pass this.
// ---------------------------------------------------------------------------

describe("the endpoint sanitizer is an allowlist", () => {
  it("an unknown field on an endpoint is dropped by default", () => {
    const raw = capturedEndpoint();
    // VACUITY: it really is on the input.
    expect((raw as unknown as Record<string, unknown>)[FUTURE_FIELD]).toBe(FUTURE_FIELD_VALUE);
    const [clean] = sanitizeForPublish([raw]);
    expect(clean).toBeDefined();
    expect(Object.keys(clean!).length).toBeGreaterThan(3); // not an empty object
    expect((clean as unknown as Record<string, unknown>)[FUTURE_FIELD]).toBeUndefined();
    expect(JSON.stringify(clean)).not.toContain(FUTURE_FIELD_VALUE);
  });

  it("an unknown field on an operation node is dropped by default", () => {
    const raw = capturedOperationNode();
    expect((raw as unknown as Record<string, unknown>)[FUTURE_FIELD]).toBe(FUTURE_FIELD_VALUE);
    const clean = sanitizeOperationNodeForPublish(raw);
    expect(clean.operation_id).toBe("op-feed-1"); // not an empty object
    expect((clean as unknown as Record<string, unknown>)[FUTURE_FIELD]).toBeUndefined();
  });

  it("an unknown key on a sub-object (csrf_plan) is dropped by default", () => {
    const raw = capturedEndpoint();
    (raw.csrf_plan as unknown as Record<string, unknown>).captured_token = LS_ACCESS_TOKEN;
    expect(JSON.stringify(raw.csrf_plan)).toContain(LS_ACCESS_TOKEN);
    const [clean] = sanitizeForPublish([raw]);
    expect(clean!.csrf_plan!.param_name).toBe("x-csrf-token"); // the plan survives
    expect(JSON.stringify(clean!.csrf_plan)).not.toContain(LS_ACCESS_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// 4. The named survivors a denylist missed.
// ---------------------------------------------------------------------------

describe("fields a denylist let through", () => {
  it("oauth_plan.token_url is refused; the grant shape survives", () => {
    const { clean, cleanBlob } = sanitizedWithGuard();
    const plan = clean.endpoints[0]!.oauth_plan!;
    expect(plan.grant_type).toBe("authorization_code");
    expect(plan.scopes).toEqual(["feed.read"]);
    expect(plan.token_url).toBeUndefined();
    expect(plan.refresh_path).toBeUndefined();
    expect(cleanBlob).not.toContain(OAUTH_TOKEN_URL);
  });

  it("constraints[].message is refused; the machine-usable rule survives", () => {
    const { clean, cleanBlob } = sanitizedWithGuard();
    const constraint = clean.endpoints[0]!.constraints![0]!;
    expect(constraint.param).toBe("auth_ctx");   // the rule is what anything reads
    expect(constraint.rule).toBe("required");
    expect(constraint.source).toBe("api_error");
    expect(constraint.message).toBeUndefined();  // the API's sentence is not
    expect(cleanBlob).not.toContain(CONSTRAINT_ECHO);
  });

  it("model-written endpoint prose is scrubbed — the regex layer used to walk JSON only", () => {
    const { clean, cleanBlob } = sanitizedWithGuard();
    expect(cleanBlob).not.toContain(PROSE_PHONE);
    expect(clean.endpoints[0]!.description).toContain("Fetch the feed");
    expect(clean.endpoints[0]!.semantic!.description_out).toContain("Returns feed items");
  });

  it("csrf_plan survives at pinned shape — it is a name→name map, read at replay time", () => {
    const { clean } = sanitizedWithGuard();
    const plan = clean.endpoints[0]!.csrf_plan!;
    expect(plan.source).toBe("cookie");
    expect(plan.param_name).toBe("x-csrf-token");
    expect(plan.extractor_sequence).toEqual(["JSESSIONID"]);
    expect(plan.refresh_on_401).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Direction two: the skill still works. A boundary that eats the graph has
//    broken the product just as badly, only quietly.
// ---------------------------------------------------------------------------

describe("the graph survives sanitization", () => {
  it("node identity, wiring, and edges are untouched", () => {
    const { clean } = sanitizedWithGuard();
    const node = clean.operation_graph!.operations[0]!;
    expect(node.operation_id).toBe("op-feed-1");
    expect(node.endpoint_id).toBe("ep-feed-1");
    expect(node.method).toBe("POST");
    expect(node.action_kind).toBe("read");
    expect(node.resource_kind).toBe("feed_item");
    expect(node.confidence).toBe(0.9);
    expect(clean.operation_graph!.entry_operation_ids).toEqual(["op-feed-1"]);
    expect(clean.operation_graph!.edges[0]!.binding_key).toBe("cursor");
    expect(clean.operation_graph!.edges[0]!.kind).toBe("pagination");
  });

  it("manifest-level identity fields are untouched", () => {
    const { clean } = sanitizedWithGuard();
    expect(clean.skill_id).toBe("sk-example-invalid");
    expect(clean.domain).toBe("example.invalid");
    expect(clean.intent_signature).toBe("read the feed");
    expect(clean.lifecycle).toBe("active");
  });

  it("drops future graph-container and edge fields by default", () => {
    const raw = capturedManifest() as SkillManifest & { operation_graph: SkillManifest["operation_graph"] & { future_capture_metadata: string } };
    raw.operation_graph!.future_capture_metadata = "alice@private.example";
    (raw.operation_graph!.edges[0] as unknown as Record<string, unknown>).future_edge_metadata = "alice@private.example";
    const graph = sanitizeManifestForPublish(raw).operation_graph! as unknown as Record<string, unknown>;
    expect(graph.future_capture_metadata).toBeUndefined();
    expect((graph.edges as Array<Record<string, unknown>>)[0]!.future_edge_metadata).toBeUndefined();
    expect(JSON.stringify(graph)).not.toContain("alice@private.example");
  });

  it("a manifest with no operation_graph is handled without inventing one", () => {
    const raw = capturedManifest();
    delete (raw as Partial<SkillManifest>).operation_graph;
    const clean = sanitizeManifestForPublish(raw);
    expect(clean.operation_graph).toBeUndefined();
    expect(clean.endpoints.length).toBe(1); // and the endpoints still got sanitized
    expect(JSON.stringify(clean)).not.toContain(FUTURE_FIELD_VALUE);
  });
});

// ---------------------------------------------------------------------------
// 6. REFUSALS WE DID NOT MAKE, pinned so they are visible rather than assumed.
//
//    `url_template` publishes its captured query values byte-identical. That is not
//    an oversight: `?queryId=feedDashMainFeed.9c1a` is ROUTE IDENTITY that replay
//    requires, and telling it apart from a session token needs information this file
//    does not have. Stripping it would break the product in the other direction, so
//    the value is left alone and the risk is named here instead of guessed at.
//    If a heuristic is ever added, this test is what should change first.
// ---------------------------------------------------------------------------

describe("remaining route shape is value-free", () => {
  it("url_template preserves query keys but refuses captured values", () => {
    const { clean } = sanitizedWithGuard();
    expect(clean.endpoints[0]!.url_template)
      .toBe("https://api.example.invalid/graphql?queryId={queryId}");
    expect(clean.operation_graph!.operations[0]!.url_template)
      .toBe("https://api.example.invalid/graphql?queryId={queryId}");
    expect(JSON.stringify(clean)).not.toContain("feedDashMainFeed.9c1a");
  });

  it("templates obvious PII and signed values in route paths and queries", () => {
    const endpoint = {
      ...capturedManifest().endpoints[0]!,
      url_template: "https://api.example.invalid/users/alice%40example.com/orders/123456?signature=secret-signed-value&email=alice%40example.com",
    } as EndpointDescriptor;
    const [clean] = sanitizeForPublish([endpoint]);
    expect(clean!.url_template).toBe("https://api.example.invalid/users/{path_1}/orders/{path_2}?signature={signature}&email={email}");
    expect(clean!.url_template).not.toContain("alice");
    expect(clean!.url_template).not.toContain("secret-signed-value");
  });

  /**
   * `buildSkillOperationGraph` promotes every captured localStorage KEY to a
   * `provides` binding so a consumer operation can auto-link to the operation that
   * produced the token. Dropping `page_metadata.localStorage` therefore removes the
   * VALUE but NOT the key, because the key also lives on `provides[]` — and `provides`
   * is the DAG's wiring, not a payload. Killing it would silently unwire the graph.
   *
   * This runs the REAL graph builder rather than a hand-written fixture, precisely so
   * the boundary is measured against what the product actually emits. The value going
   * and the key staying are both asserted: the day someone decides key names are too
   * much, this is the test that says what it costs.
   */
  it("a promoted localStorage KEY survives on provides[]; only the VALUE is refused", () => {
    const graph = buildSkillOperationGraph(
      [{
        endpoint_id: "e1", method: "GET",
        url_template: "https://api.example.invalid/feed",
        idempotency: "safe", verification_status: "verified", reliability_score: 0.9,
      }] as unknown as EndpointDescriptor[],
      { localStorage: { [LS_USER_SCOPED_KEY]: LS_ACCESS_TOKEN }, embedded_json: [] },
    );
    // VACUITY: the builder really promoted the key AND really stored the value.
    const rawBlob = JSON.stringify(graph);
    expect(rawBlob).toContain(LS_ACCESS_TOKEN);
    expect(graph.operations[0]!.provides.some((p) => p.key === LS_USER_SCOPED_KEY)).toBe(true);

    const blob = JSON.stringify(sanitizeOperationGraphForPublish(graph));
    expect(blob.length).toBeGreaterThan(100);           // not an empty graph
    expect(blob).not.toContain(LS_ACCESS_TOKEN);        // the token is refused
    expect(blob).toContain(LS_USER_SCOPED_KEY);         // the key is not — named, not hidden
  });
});

// ---------------------------------------------------------------------------
// 7. Call-site wiring.
//
//    HONEST LABEL: this is a SOURCE pin, not an execution pin. Driving the real
//    publish paths would need a network seam these two routes do not expose, and
//    `mock.module` is process-wide in bun and forbidden here. What it does catch is
//    the regression that actually happens: someone adds or restores a `publishSkill`
//    call on one of these paths and hands it a raw manifest.
// ---------------------------------------------------------------------------

describe("manifest top-level is an allowlist", () => {
  it("scrubs top-level prose and drops future capture/composite fields", () => {
    const raw = {
      ...capturedManifest(),
      description: "Captured for alice@private.example at +1-415-555-0123",
      future_capture_blob: { email: "alice@private.example" },
      composites: [{ composite_id: "raw-private-chain", steps: [{ body: "private" }] }],
    } as SkillManifest & { future_capture_blob: unknown };
    const clean = sanitizeManifestForPublish(raw) as Record<string, unknown>;
    expect(JSON.stringify(clean)).not.toContain("alice@private.example");
    expect(JSON.stringify(clean)).not.toContain("415-555-0123");
    expect(clean.future_capture_blob).toBeUndefined();
    expect(clean.composites).toBeUndefined();
  });
});

describe("the shared marketplace transport is the publication boundary", () => {
  it("sanitizes immediately before the only remote client publish", () => {
    const relative = "src/marketplace/index.ts";
    const source = readFileSync(join(import.meta.dir, "..", relative), "utf-8");
    expect(source).toContain("const sanitizedDraft = sanitizeManifestForPublish(draft)");
    expect(source).toContain("clientAdapter.publishSkill(sanitizedDraft, {");
    expect(source).toContain("idempotencyKey: authorization.publish_permit.permit_id");
  });

  it("former API/orchestrator paths cannot call the remote client directly", () => {
    for (const relative of ["src/api/routes.ts", "src/orchestrator/index.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", relative), "utf-8");
      expect(source).not.toMatch(/client(?:Adapter)?\.publishSkill\(/);
    }
  });
});
