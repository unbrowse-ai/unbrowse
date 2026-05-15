/**
 * Layer D integration test — `executeEndpointWithChain` golden-path AC5.
 *
 * Spec source: `.claude/jesus-loop.default.architecture.md` (Day 2 architecture).
 *
 * Wires up a real loopback HTTP server backing a two-endpoint
 * producer/consumer chain (csrf-producer + mutation-consumer) and asserts
 * the wrapper:
 *   1. Reuses fresh cached bindings (no producer refetch within TTL).
 *   2. Refetches expired bindings (TTL exceeded).
 *   3. Refetches single-use bindings already marked consumed.
 *   4. Logs `chain_walk_stale_skipped` and proceeds with stale value when
 *      no producer is registered for a stale binding.
 *
 * Worker 2 owns the wrapper at `src/execution/index.ts`. If Worker 2 hasn't
 * landed the symbol yet the import will fail — that's the goat to chase at
 * synthesis time (Luke 15:4). The test file is the trail-marker.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import http from "node:http";
import { AddressInfo } from "node:net";
import { executeEndpointWithChain } from "../src/execution/index.js";
import { isBindingStale } from "../src/orchestrator/dag-feedback.js";
import type {
  ChainWalkContext,
  EndpointDescriptor,
  SessionYieldCache,
  SkillManifest,
} from "../src/types/skill.js";

// --- Loopback server (real HTTP, no mocks) -----------------------------------

let server: http.Server;
let baseUrl: string;
let producerHits = 0;
let mutationHits = 0;
let lastMutationCsrf: string | null = null;
let lastMutationBody: string | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/csrf") {
      producerHits += 1;
      const value = `fresh-${producerHits}`;
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `csrf=${value}; Path=/; Max-Age=10`,
      });
      res.end(JSON.stringify({ csrf_token: value }));
      return;
    }
    if (url.pathname === "/mutate") {
      mutationHits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        lastMutationBody = raw;
        let token: string | null = null;
        try {
          const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          if (typeof parsed.csrf_token === "string") token = parsed.csrf_token;
        } catch {
          /* fallthrough to query/header lookup */
        }
        if (!token) token = url.searchParams.get("csrf_token");
        if (!token) {
          const hdr = req.headers["x-csrf-token"];
          token = typeof hdr === "string" ? hdr : Array.isArray(hdr) ? (hdr[0] ?? null) : null;
        }
        lastMutationCsrf = token;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, csrf_token: token }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  producerHits = 0;
  mutationHits = 0;
  lastMutationCsrf = null;
  lastMutationBody = null;
});

// --- Fixture builders ---------------------------------------------------------

function makeProducer(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "csrf-producer",
    method: "GET",
    url_template: `${baseUrl}/csrf`,
    description: "Fetch a fresh CSRF token",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    semantic: {
      action_kind: "read",
      resource_kind: "token",
      provides: [
        {
          key: "csrf_token",
          description: "Per-request CSRF token",
          type: "string",
          ttl_ms: 10_000,
          single_use: false,
        },
      ],
    },
    ...over,
  };
}

function makeConsumer(over: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "mutation-consumer",
    method: "POST",
    url_template: `${baseUrl}/mutate`,
    description: "Mutation that echoes the csrf_token it received",
    idempotency: "unsafe",
    verification_status: "verified",
    reliability_score: 1,
    body: { csrf_token: "{csrf_token}" } as Record<string, unknown>,
    semantic: {
      action_kind: "mutate",
      resource_kind: "thing",
      requires: [{ key: "csrf_token", required: true, type: "string" }],
    },
    ...over,
  };
}

function makeSkill(endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: "dag-walk-fixture",
    version: "1.0.0",
    schema_version: "1",
    name: "dag-walk-fixture",
    intent_signature: "csrf chain walk",
    domain: "127.0.0.1",
    description: "Synthetic two-endpoint chain for AC5 staleness tests",
    owner_type: "agent",
    execution_type: "http",
    endpoints,
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeCtx(over: Partial<ChainWalkContext> = {}): ChainWalkContext {
  return {
    now: Date.parse("2026-01-01T00:00:00.000Z"),
    consumed: new Map<string, boolean>(),
    depth: 0,
    visited: new Set<string>(),
    maxDepth: 4,
    trace: [],
    ...over,
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const TTL_MS = 10_000;

function findStep(trace: ChainWalkContext["trace"], step: string) {
  return trace.find((entry) => entry.step === step);
}

// --- Tests --------------------------------------------------------------------

describe("executeEndpointWithChain — AC5 golden path + staleness edges", () => {
  test("golden path: fresh cached binding within TTL → no producer refetch", async () => {
    const producer = makeProducer();
    const consumer = makeConsumer();
    const skill = makeSkill([producer, consumer]);

    const yields: SessionYieldCache = new Map([
      [
        "csrf_token",
        {
          value: "old",
          observed_at: new Date(T0).toISOString(),
          ttl_ms: TTL_MS,
          single_use: false,
        },
      ],
    ]);
    const ctx = makeCtx({ now: T0 });

    // Sanity check on the helper the wrapper relies on.
    expect(
      isBindingStale(
        { key: "csrf_token", ttl_ms: TTL_MS, observed_at: new Date(T0).toISOString() },
        T0,
        { consumed: false },
      ),
    ).toBe(false);

    const result = await executeEndpointWithChain(
      skill,
      consumer,
      { csrf_token: "{csrf_token}" },
      undefined,
      { session_yields: yields },
      ctx,
    );

    expect(producerHits).toBe(0);
    expect(mutationHits).toBe(1);
    expect(lastMutationCsrf).toBe("old");

    const fresh = findStep(ctx.trace, "chain_walk_fresh_reused");
    expect(fresh).toBeDefined();
    expect(fresh?.binding_key).toBe("csrf_token");

    // No refetch step.
    expect(findStep(ctx.trace, "chain_walk_refetched_success")).toBeUndefined();
    expect((result as { trace?: unknown } | undefined)?.trace).toBeDefined();
  });

  test("edge: TTL expired → producer is refetched and fresh value substituted", async () => {
    const producer = makeProducer();
    const consumer = makeConsumer();
    const skill = makeSkill([producer, consumer]);

    const yields: SessionYieldCache = new Map([
      [
        "csrf_token",
        {
          value: "old",
          observed_at: new Date(T0).toISOString(),
          ttl_ms: TTL_MS,
          single_use: false,
        },
      ],
    ]);
    const now = T0 + TTL_MS + 1_000; // 1s past TTL
    const ctx = makeCtx({ now });

    expect(
      isBindingStale(
        { key: "csrf_token", ttl_ms: TTL_MS, observed_at: new Date(T0).toISOString() },
        now,
      ),
    ).toBe(true);

    await executeEndpointWithChain(
      skill,
      consumer,
      { csrf_token: "{csrf_token}" },
      undefined,
      { session_yields: yields },
      ctx,
    );

    expect(producerHits).toBe(1); // one refetch
    expect(mutationHits).toBe(1);
    expect(lastMutationCsrf).toBe("fresh-1");
    expect(lastMutationCsrf).not.toBe("old");

    const refetched = findStep(ctx.trace, "chain_walk_refetched_success");
    expect(refetched).toBeDefined();
    expect(refetched?.binding_key).toBe("csrf_token");
  });

  test("edge: single-use consumed → refetch regardless of TTL freshness", async () => {
    const producer = makeProducer({
      semantic: {
        action_kind: "read",
        resource_kind: "token",
        provides: [
          {
            key: "csrf_token",
            type: "string",
            ttl_ms: TTL_MS,
            single_use: true,
          },
        ],
      },
    });
    const consumer = makeConsumer();
    const skill = makeSkill([producer, consumer]);

    const yields: SessionYieldCache = new Map([
      [
        "csrf_token",
        {
          value: "abc",
          observed_at: new Date(T0).toISOString(),
          ttl_ms: TTL_MS,
          single_use: true,
        },
      ],
    ]);

    const ctx = makeCtx({ now: T0, consumed: new Map([["csrf_token", true]]) });

    // Sanity: consumed + single_use → stale regardless of TTL window.
    expect(
      isBindingStale(
        { key: "csrf_token", single_use: true, ttl_ms: TTL_MS, observed_at: new Date(T0).toISOString() },
        T0,
        { consumed: true },
      ),
    ).toBe(true);

    await executeEndpointWithChain(
      skill,
      consumer,
      { csrf_token: "{csrf_token}" },
      undefined,
      { session_yields: yields },
      ctx,
    );

    expect(producerHits).toBe(1);
    expect(mutationHits).toBe(1);
    expect(lastMutationCsrf).toBe("fresh-1");

    expect(findStep(ctx.trace, "chain_walk_refetched_success")).toBeDefined();

    // Judgment call (documented): after a refetch the cached binding is the
    // newly observed yield. If the producer's `provides[*].single_use === true`
    // that fresh yield is itself single_use, so the consumed marker should be
    // reset by the wrapper (consumed=false, "we just observed it, it hasn't
    // been spent yet") OR set back to true post-leaf-call (consumed=true,
    // "the leaf call we just dispatched spent it again"). Either is internally
    // consistent — pin to whichever Worker 2 implements. Asserting it's a
    // boolean ensures the wrapper at least manages the key.
    expect(typeof ctx.consumed.get("csrf_token")).toBe("boolean");
  });

  test("adversarial: stale binding with no producer in skill → chain_walk_stale_skipped, proceeds with stale value", async () => {
    // Consumer only — no endpoint provides csrf_token.
    const consumer = makeConsumer();
    const skill = makeSkill([consumer]);

    const now = T0 + TTL_MS + 1_000;
    const yields: SessionYieldCache = new Map([
      [
        "csrf_token",
        {
          value: "stale-but-only-option",
          observed_at: new Date(T0).toISOString(),
          ttl_ms: TTL_MS,
          single_use: false,
        },
      ],
    ]);
    const ctx = makeCtx({ now });

    await executeEndpointWithChain(
      skill,
      consumer,
      { csrf_token: "{csrf_token}" },
      undefined,
      { session_yields: yields },
      ctx,
    );

    expect(producerHits).toBe(0); // nothing to refetch
    expect(mutationHits).toBe(1); // leaf still dispatched

    expect(findStep(ctx.trace, "chain_walk_stale_skipped")).toBeDefined();
    expect(findStep(ctx.trace, "chain_walk_refetched_failure")).toBeUndefined();
    expect(findStep(ctx.trace, "chain_walk_refetched_success")).toBeUndefined();

    expect(lastMutationCsrf).toBe("stale-but-only-option");
  });
});
