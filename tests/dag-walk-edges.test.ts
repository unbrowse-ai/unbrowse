// Day 5 / Worker 4 — adversarial edge-case tests for executeEndpointWithChain.
//
// Companion to tests/dag-walk-staleness.test.ts (Worker 3 golden path). This
// file probes ONLY the four architectural failure modes documented in
// (internal) method-loop.default.architecture.md:
//
//   1. depth-cap exceeded            → chain_walk_depth_exceeded
//   2. cycle detected                → chain_walk_cycle_detected
//   3. producer refetch returns 5xx  → chain_walk_refetched_failure
//   4. consumed-map cross-call behaviour within a single walk context
//
// Contract pins read from src/execution/index.ts:3239+ (Worker 2's wrapper):
//   - Walk is keyed on `options.session_yields` — a SessionYieldCache must be
//     populated for the wrapper to evaluate staleness at all.
//   - Freshness metadata lives on the cached SessionYield (ttl_ms / observed_at
//     / single_use), NOT on the consumer's `requires[]` binding.
//   - Cycle step records `producer_endpoint_id` (not `endpoint_id`).
//   - Depth check is `ctx.depth >= ctx.maxDepth`. depth=0 is the top-level
//     frame; with maxDepth=N, the Nth recursion is the one that aborts.
//   - On producer non-2xx the wrapper records reason="producer_non_2xx" and
//     a numeric status_code field. It does NOT abort the leaf call — the leaf
//     fires with the stale value still in place. (See "Implementation choice"
//     in case 3 below.)
//   - Single-use consumption fires AFTER the leaf call; `ctx.consumed.set(key,
//     true)` for every binding marked single_use. A subsequent walk with the
//     same ctx sees that consumed state and treats the yield as stale.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { executeEndpointWithChain } from "../src/execution/index.js";
import type {
  ChainWalkContext,
  DecisionTraceStep,
  EndpointDescriptor,
  ExecutionOptions,
  OperationBinding,
  SessionYield,
  SessionYieldCache,
  SkillManifest,
} from "../src/types/skill.js";

// ---------------------------------------------------------------------------
// Fixture helpers — shared shape with Worker 3 but constructed inline so the
// two files do not import each other.
// ---------------------------------------------------------------------------

function mkBinding(over: Partial<OperationBinding> & { key: string }): OperationBinding {
  return {
    description: `binding ${over.key}`,
    type: "string",
    required: true,
    ...over,
  };
}

function mkEndpoint(over: Partial<EndpointDescriptor> & { endpoint_id: string }): EndpointDescriptor {
  return {
    method: "GET",
    url_template: "https://example.invalid/never-called",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: `endpoint ${over.endpoint_id}`,
    ...over,
  } as EndpointDescriptor;
}

function mkSkill(endpoints: EndpointDescriptor[], over: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "test-chain-edges",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "chain-edges-fixture",
    intent_signature: "chain edges",
    domain: "127.0.0.1",
    description: "synthetic chain-walk fixtures",
    owner_type: "agent",
    endpoints,
    ...over,
  };
}

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const STALE_AT = new Date(NOW - 60 * 60 * 1_000).toISOString(); // 1h ago
const FRESH_AT = new Date(NOW - 1_000).toISOString();           // 1s ago

function freshCtx(over: Partial<ChainWalkContext> = {}): ChainWalkContext {
  return {
    now: NOW,
    consumed: new Map<string, boolean>(),
    depth: 0,
    visited: new Set<string>(),
    maxDepth: 4,
    trace: [],
    ...over,
  };
}

function staleYield(over: Partial<SessionYield> = {}): SessionYield {
  return {
    value: "stale-value",
    observed_at: STALE_AT,
    ttl_ms: 60_000, // 1 minute TTL; observed 1h ago → stale.
    ...over,
  };
}

function traceSteps(ctx: ChainWalkContext): string[] {
  return ctx.trace.map((s: DecisionTraceStep) => s.step);
}

// ---------------------------------------------------------------------------
// Local HTTP server — counts hits per path so depth/cycle tests can assert
// the walk aborted BEFORE any producer fired, and the refetch-failure test
// can return a deterministic 5xx.
// ---------------------------------------------------------------------------

interface HitCounter {
  total: number;
  byPath: Map<string, number>;
}

let server: http.Server;
let baseUrl: string;
const hits: HitCounter = { total: 0, byPath: new Map() };
const routeStatus = new Map<string, number>();
const routeBody = new Map<string, unknown>();

function resetHits() {
  hits.total = 0;
  hits.byPath.clear();
  routeStatus.clear();
  routeBody.clear();
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      hits.total += 1;
      hits.byPath.set(path, (hits.byPath.get(path) ?? 0) + 1);
      const status = routeStatus.get(path) ?? 200;
      const body = routeBody.get(path);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body ?? { ok: status < 400 }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// 1. Depth-cap exceeded.
// ---------------------------------------------------------------------------
//
// Chain: A requires b → B; B requires c → C; C requires d → D; D requires e → E.
// Every binding in the cache is stale. With ctx.maxDepth = 3, the walk
// at depth=3 hits `chain_walk_depth_exceeded` instead of recursing into the
// fourth producer. We pin the trace step + verify the deepest producer was
// never HTTP-called.

describe("executeEndpointWithChain — depth cap (R3 diagnostic)", () => {
  test("aborts with chain_walk_depth_exceeded; deep producer never fires", async () => {
    resetHits();
    routeStatus.set("/A", 200); routeBody.set("/A", { ok: true });
    routeStatus.set("/B", 200); routeBody.set("/B", { b: "fresh-b" });
    routeStatus.set("/C", 200); routeBody.set("/C", { c: "fresh-c" });
    routeStatus.set("/D", 200); routeBody.set("/D", { d: "fresh-d" });
    routeStatus.set("/E", 200); routeBody.set("/E", { e: "fresh-e" });

    const endpointE = mkEndpoint({
      endpoint_id: "E",
      url_template: `${baseUrl}/E`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        provides: [mkBinding({ key: "e" })],
      },
    });
    const endpointD = mkEndpoint({
      endpoint_id: "D",
      url_template: `${baseUrl}/D`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        requires: [mkBinding({ key: "e" })],
        provides: [mkBinding({ key: "d" })],
      },
    });
    const endpointC = mkEndpoint({
      endpoint_id: "C",
      url_template: `${baseUrl}/C`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        requires: [mkBinding({ key: "d" })],
        provides: [mkBinding({ key: "c" })],
      },
    });
    const endpointB = mkEndpoint({
      endpoint_id: "B",
      url_template: `${baseUrl}/B`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        requires: [mkBinding({ key: "c" })],
        provides: [mkBinding({ key: "b" })],
      },
    });
    const endpointA = mkEndpoint({
      endpoint_id: "A",
      url_template: `${baseUrl}/A`,
      semantic: {
        action_kind: "mutate",
        resource_kind: "thing",
        requires: [mkBinding({ key: "b" })],
      },
    });

    // Pre-populate session_yields with stale entries for every dependency key.
    // Without these the wrapper has nothing to evaluate and skips the walk.
    const session_yields: SessionYieldCache = new Map();
    session_yields.set("b", staleYield());
    session_yields.set("c", staleYield());
    session_yields.set("d", staleYield());
    session_yields.set("e", staleYield());

    const skill = mkSkill([endpointA, endpointB, endpointC, endpointD, endpointE]);
    const ctx = freshCtx({ maxDepth: 3 });
    const opts: ExecutionOptions = { session_yields };

    await executeEndpointWithChain(skill, endpointA, {}, undefined, opts, ctx);

    const steps = traceSteps(ctx);
    expect(steps).toContain("chain_walk_depth_exceeded");

    const depthStep = ctx.trace.find((s) => s.step === "chain_walk_depth_exceeded");
    // depth was at least the configured cap when the abort fired.
    expect(typeof depthStep?.depth).toBe("number");
    expect((depthStep?.depth as number) >= 3).toBe(true);

    // The endpoint past the cap (E — 4 hops in) must NOT have been HTTP-called.
    expect(hits.byPath.get("/E") ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cycle detected.
// ---------------------------------------------------------------------------
//
// A requires b (provided by B). B requires a (provided by A). Both yields
// stale. We pre-populate ctx.visited with B's id so the cycle is detected on
// the first attempt to recurse into B. (Without pre-population the wrapper
// adds visits as it recurses; pre-populating models the case where a parent
// walk frame already visited this producer.)

describe("executeEndpointWithChain — cycle detection", () => {
  test("aborts with chain_walk_cycle_detected and does not stack-overflow", async () => {
    resetHits();
    routeStatus.set("/cycle-A", 200);
    routeBody.set("/cycle-A", { a: "fresh-a" });
    routeStatus.set("/cycle-B", 200);
    routeBody.set("/cycle-B", { b: "fresh-b" });

    const endpointA = mkEndpoint({
      endpoint_id: "cycle-A",
      url_template: `${baseUrl}/cycle-A`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        requires: [mkBinding({ key: "b" })],
        provides: [mkBinding({ key: "a" })],
      },
    });
    const endpointB = mkEndpoint({
      endpoint_id: "cycle-B",
      url_template: `${baseUrl}/cycle-B`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        requires: [mkBinding({ key: "a" })],
        provides: [mkBinding({ key: "b" })],
      },
    });

    const session_yields: SessionYieldCache = new Map();
    session_yields.set("a", staleYield());
    session_yields.set("b", staleYield());

    const skill = mkSkill([endpointA, endpointB]);
    const ctx = freshCtx({ maxDepth: 10 });
    // Pre-populate visited with B's endpoint_id so the walk from A detects
    // the cycle immediately on its first refetch attempt.
    ctx.visited.add("cycle-B");

    let threw: unknown = null;
    try {
      await executeEndpointWithChain(
        skill,
        endpointA,
        {},
        undefined,
        { session_yields },
        ctx,
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull(); // no stack overflow / unhandled throw

    const steps = traceSteps(ctx);
    expect(steps).toContain("chain_walk_cycle_detected");

    const cycleStep = ctx.trace.find((s) => s.step === "chain_walk_cycle_detected");
    // Wrapper records the producer that would have been re-entered.
    expect(cycleStep?.producer_endpoint_id).toBe("cycle-B");
  });
});

// ---------------------------------------------------------------------------
// 3. Producer refetch returns 5xx.
// ---------------------------------------------------------------------------
//
// Producer at /producer-500 returns 500 every time. Consumer's csrf_token
// yield is stale. Walk attempts the refetch, observes the 5xx, must emit
// chain_walk_refetched_failure with reason naming non-2xx (the current impl
// uses reason="producer_non_2xx" + status_code field).
//
// We use 400 (not 500) because executeEndpoint triggers a libcurl-impersonate
// SSR fastpath fallback on 5xx (src/execution/index.ts:3025+) that hangs
// against our localhost test server. 4xx exercises the same chain-walk
// non-2xx path without firing the fallback. The architecture spec explicitly
// covers "4xx/5xx" — either status proves the same wrapper branch.
//
// Implementation choice (pinned to the wrapper at execution/index.ts:3493+):
//   The wrapper does NOT abort the leaf call on producer failure — it logs
//   the failure to the trace and proceeds with the stale value still in
//   place. So the consumer endpoint WILL be HTTP-called. If a future
//   wrapper changes to "abort branch", the leaf-hit assertion below will
//   flip and should be revisited.

describe("executeEndpointWithChain — producer refetch non-2xx", () => {
  test("emits chain_walk_refetched_failure with reason naming the non-2xx status", async () => {
    resetHits();
    routeStatus.set("/producer-fail", 400);
    routeBody.set("/producer-fail", { error: "bad_request" });
    routeStatus.set("/consumer", 200);
    routeBody.set("/consumer", { ok: true });

    const producer = mkEndpoint({
      endpoint_id: "producer-fail",
      url_template: `${baseUrl}/producer-fail`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        provides: [mkBinding({ key: "csrf_token" })],
      },
    });
    const consumer = mkEndpoint({
      endpoint_id: "consumer",
      url_template: `${baseUrl}/consumer`,
      method: "POST",
      semantic: {
        action_kind: "mutate",
        resource_kind: "post",
        requires: [mkBinding({ key: "csrf_token" })],
      },
    });

    const session_yields: SessionYieldCache = new Map();
    session_yields.set("csrf_token", staleYield());

    const skill = mkSkill([consumer, producer]);
    const ctx = freshCtx();

    await executeEndpointWithChain(
      skill,
      consumer,
      {},
      undefined,
      { session_yields },
      ctx,
    );

    const steps = traceSteps(ctx);
    expect(steps).toContain("chain_walk_refetched_failure");

    const failureStep = ctx.trace.find((s) => s.step === "chain_walk_refetched_failure");
    expect(failureStep?.producer_endpoint_id).toBe("producer-fail");

    // Reason field must surface the non-2xx nature. Current impl emits
    //   reason: "producer_non_2xx", status_code: 400
    // — accept either the reason string or the explicit status_code field.
    const reasonStr = String(failureStep?.reason ?? "");
    const statusField = failureStep?.status_code;
    const mentionsNon2xx =
      reasonStr.includes("non_2xx") ||
      reasonStr.includes("non-2xx") ||
      reasonStr.includes("4xx") ||
      reasonStr.includes("400") ||
      statusField === 400;
    expect(mentionsNon2xx).toBe(true);

    // Producer was attempted at least once — the wrapper can only know the
    // status by issuing the call.
    expect((hits.byPath.get("/producer-fail") ?? 0) >= 1).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Consumed map within a single walk.
// ---------------------------------------------------------------------------

describe("executeEndpointWithChain — single_use consumption", () => {
  test("two single_use bindings co-yielded by one producer are refetched ONCE per walk", async () => {
    resetHits();
    routeStatus.set("/auth", 200);
    // Producer body surfaces BOTH keys so extractBindingFromResult succeeds
    // for each.
    routeBody.set("/auth", { session_id: "sess-1", csrf_token: "csrf-1" });
    routeStatus.set("/post", 200);
    routeBody.set("/post", { ok: true });

    const auth = mkEndpoint({
      endpoint_id: "auth",
      url_template: `${baseUrl}/auth`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        // Producer declares both bindings as single_use; the wrapper
        // copies single_use through to the refreshed yield.
        provides: [
          mkBinding({ key: "session_id", single_use: true }),
          mkBinding({ key: "csrf_token", single_use: true }),
        ],
      },
    });
    const post = mkEndpoint({
      endpoint_id: "post",
      url_template: `${baseUrl}/post`,
      method: "POST",
      semantic: {
        action_kind: "mutate",
        resource_kind: "post",
        requires: [
          mkBinding({ key: "session_id" }),
          mkBinding({ key: "csrf_token" }),
        ],
      },
    });

    // Both yields stale — wrapper must refetch the (single) producer to
    // freshen them. The contract under test: ONE producer call covers BOTH
    // co-yielded bindings, not two.
    const session_yields: SessionYieldCache = new Map();
    session_yields.set("session_id", staleYield({ single_use: true }));
    session_yields.set("csrf_token", staleYield({ single_use: true }));

    const skill = mkSkill([post, auth]);
    const ctx = freshCtx();

    await executeEndpointWithChain(
      skill,
      post,
      {},
      undefined,
      { session_yields },
      ctx,
    );

    // Even though two bindings needed refetch, /auth was hit exactly ONCE.
    // The second-pass refetch is short-circuited by the freshly-cached
    // yield emitted during the first iteration of the requires[] walk.
    expect(hits.byPath.get("/auth")).toBe(1);

    // Both bindings end up marked consumed after the leaf call (single_use).
    expect(ctx.consumed.get("session_id")).toBe(true);
    expect(ctx.consumed.get("csrf_token")).toBe(true);
  });

  test("a pre-consumed binding forces a fresh producer refetch on the next walk in the same ctx", async () => {
    resetHits();
    routeStatus.set("/auth2", 200);
    routeBody.set("/auth2", { session_id: "sess-2", csrf_token: "csrf-2" });
    routeStatus.set("/post2", 200);
    routeBody.set("/post2", { ok: true });

    const auth = mkEndpoint({
      endpoint_id: "auth2",
      url_template: `${baseUrl}/auth2`,
      semantic: {
        action_kind: "auth",
        resource_kind: "token",
        provides: [
          mkBinding({ key: "session_id", single_use: true }),
          mkBinding({ key: "csrf_token", single_use: true }),
        ],
      },
    });
    const post = mkEndpoint({
      endpoint_id: "post2",
      url_template: `${baseUrl}/post2`,
      method: "POST",
      semantic: {
        action_kind: "mutate",
        resource_kind: "post",
        requires: [
          mkBinding({ key: "session_id" }),
          mkBinding({ key: "csrf_token" }),
        ],
      },
    });

    // FRESH on the wall-clock — observed 1s ago with a long TTL. The only
    // reason a refetch can fire is consumed-state forcing staleness.
    const session_yields: SessionYieldCache = new Map();
    session_yields.set("session_id", {
      value: "old-sess",
      observed_at: FRESH_AT,
      ttl_ms: 60_000,
      single_use: true,
    });
    session_yields.set("csrf_token", {
      value: "old-csrf",
      observed_at: FRESH_AT,
      ttl_ms: 60_000,
      single_use: true,
    });

    const skill = mkSkill([post, auth]);
    const ctx = freshCtx();

    // First walk: yields are TTL-fresh AND not yet consumed → no refetch.
    await executeEndpointWithChain(
      skill,
      post,
      {},
      undefined,
      { session_yields },
      ctx,
    );
    const hitsAfterFirst = hits.byPath.get("/auth2") ?? 0;

    // Stamp consumed BEFORE the second walk. The wrapper will re-read
    // session_yields, ask isBindingStale with usage.consumed=true for
    // session_id, and that should flip the predicate to stale → refetch.
    ctx.consumed.set("session_id", true);

    await executeEndpointWithChain(
      skill,
      post,
      {},
      undefined,
      { session_yields },
      ctx,
    );
    const hitsAfterSecond = hits.byPath.get("/auth2") ?? 0;

    expect(hitsAfterSecond).toBeGreaterThan(hitsAfterFirst);
  });
});
