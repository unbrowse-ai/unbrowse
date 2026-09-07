/**
 * Day 6 (Genesis Dominion) — caps-fire-BEFORE-signing regression test.
 *
 * Phase 4 of v6.16 introduces a second sponsor settlement rail (Faremeter
 * Flex authorizations, `services/sponsor-flex.ts`) alongside the existing
 * direct-SPL path (`services/sponsor-pay.ts`). Both rails must remain GATED
 * by the same per-agent + global daily caps that v6.15 already enforces.
 *
 * The decision order in `maybeSponsor` is non-negotiable:
 *   1. opt-out header
 *   2. wallet readiness
 *   3. agent_cap check (read KV rollup)
 *   4. global_cap check (read KV rollup)
 *   5. *only then* call the rail (payFn for direct-SPL, flexPayFn for Flex)
 *
 * This test exercises (5) with BOTH rails wired. If a future refactor moves
 * the cap check below the rail call — or only gates one rail and not the
 * other — these assertions break.
 *
 * The test injects spies for `payFn` AND `flexPayFn`. Both must remain
 * un-called on any cap/opt-out path. No real RPC, no real signing — same
 * dependency-injection seam pattern as `sponsor-middleware.test.ts`.
 *
 * Coordination note: as of Day 6, Worker 1's `sponsor-flex.ts` service
 * exists but `maybeSponsor` does not yet accept a `flexPayFn` opt. When
 * the seam lands (Phase 4 wiring), these tests will pass; until then they
 * fail-loud and pin the contract.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetSponsorMiddlewareStateForTests,
  maybeSponsor,
} from "../src/middleware/sponsor.js";
import type { X402PaymentRequirementV2 } from "../src/middleware/x402-gate.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";

// --- Test fixtures ----------------------------------------------------------

function makeMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeEnv(opts: {
  withWallet?: boolean;
  agentCapUsd?: string;
  globalCapUsd?: string;
  kvSeed?: Record<string, string>;
  useFlexSplit?: boolean;
}): Env {
  if (opts.kvSeed) {
    const localKv = new LocalKV("stats");
    for (const [k, v] of Object.entries(opts.kvSeed)) {
      void localKv.put(k, v);
    }
  }
  return {
    API_KEY: "test-api-key",
    EMERGENTDB_API_KEY: "x",
    NEBIUS_API_KEY: "x",
    TURBOBOX_URL: "x",
    FAL_KEY: "x",
    R2_BUCKET: {} as R2Bucket,
    STATS_KV: makeMemoryKv(),
    ENVIRONMENT: "local-dev",
    PLATFORM_SPONSOR_WALLET_ADDRESS: opts.withWallet
      ? "So1PlatformWallet1111111111111111111111111111"
      : undefined,
    PLATFORM_SPONSOR_WALLET_KEY: opts.withWallet ? "deadbeef" : undefined,
    SPONSOR_CAP_DAILY_USD: opts.agentCapUsd,
    SPONSOR_GLOBAL_DAILY_USD: opts.globalCapUsd,
    SPONSOR_USE_FLEX_SPLIT: opts.useFlexSplit ? "1" : undefined,
    FLEX_SPONSOR_ESCROW_ADDRESS: opts.useFlexSplit ? "FlexEscrow11111111111111111111111111111111" : undefined,
    FLEX_SPONSOR_SESSION_KEY_SECRET: opts.useFlexSplit ? "deadbeefcafebabe" : undefined,
  } as Env;
}

function makeContext(
  env: Env,
  opts?: { url?: string; headers?: Record<string, string> },
): Parameters<typeof maybeSponsor>[0] {
  const url = opts?.url ?? "http://localhost/v1/skills/skill-test";
  const headers = opts?.headers ?? {};
  return {
    env,
    req: {
      header: (name: string) => headers[name],
      url,
    },
  } as unknown as Parameters<typeof maybeSponsor>[0];
}

const STD_TERMS: X402PaymentRequirementV2[] = [
  {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: "1000", // 1000 µ¢ = $0.001 USDC
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "So1Creator9999999999999999999999999999999999",
    maxTimeoutSeconds: 300,
  },
];

beforeEach(() => {
  _resetSponsorMiddlewareStateForTests();
  clearKVCacheForTests("stats");
});

// --- Cap fires BEFORE rail signing — direct-SPL rail ------------------------

describe("sponsor caps (Phase 4) — fire BEFORE direct-SPL signing", () => {
  test("agent at cap → payFn never called", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const dateStr = "2026-05-14";
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      kvSeed: { [`sponsor:agent:agent-A:${dateStr}`]: "1000000" },
    });
    const c = makeContext(env);
    let payFnCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async () => {
        payFnCalled = true;
        return { success: true, signature: "should-not-fire" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") expect(decision.reason).toBe("agent_cap");
    expect(payFnCalled).toBe(false);
  });

  test("global at cap → payFn never called", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const dateStr = "2026-05-14";
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      globalCapUsd: "50.0",
      kvSeed: { [`sponsor:global:${dateStr}`]: "50000000" },
    });
    const c = makeContext(env);
    let payFnCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async () => {
        payFnCalled = true;
        return { success: true, signature: "should-not-fire" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") expect(decision.reason).toBe("global_cap");
    expect(payFnCalled).toBe(false);
  });

  test("opt-out → payFn never called (cap not even read)", async () => {
    const env = makeEnv({ withWallet: true });
    const c = makeContext(env, { headers: { "X-No-Sponsor": "1" } });
    let payFnCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      payFn: async () => {
        payFnCalled = true;
        return { success: true, signature: "should-not-fire" };
      },
    });
    expect(decision.kind).toBe("opted_out");
    expect(payFnCalled).toBe(false);
  });
});

// --- Cap fires BEFORE rail signing — Flex rail ------------------------------
//
// These tests require the `flexPayFn` seam on `maybeSponsor`. When Phase 4
// wiring lands (Worker 1 -> middleware glue), these will type-check + pass.
// Until then they fail loudly — the failure IS the coordination contract.

describe("sponsor caps (Phase 4) — fire BEFORE Flex signing", () => {
  test("agent at cap → flexPayFn never called", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const dateStr = "2026-05-14";
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      useFlexSplit: true,
      kvSeed: { [`sponsor:agent:agent-A:${dateStr}`]: "1000000" },
    });
    const c = makeContext(env);
    let flexCalled = false;
    let payFnCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async () => {
        payFnCalled = true;
        return { success: true, signature: "direct-not-fire" };
      },
      // @ts-expect-error — seam not landed yet; this is the coordination probe.
      flexPayFn: async () => {
        flexCalled = true;
        return { ok: true, authorization_id: "auth-not-fire" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") expect(decision.reason).toBe("agent_cap");
    expect(flexCalled).toBe(false);
    expect(payFnCalled).toBe(false);
  });

  test("global at cap → flexPayFn never called", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const dateStr = "2026-05-14";
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      globalCapUsd: "50.0",
      useFlexSplit: true,
      kvSeed: { [`sponsor:global:${dateStr}`]: "50000000" },
    });
    const c = makeContext(env);
    let flexCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      // @ts-expect-error — seam not landed yet.
      flexPayFn: async () => {
        flexCalled = true;
        return { ok: true, authorization_id: "auth-not-fire" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") expect(decision.reason).toBe("global_cap");
    expect(flexCalled).toBe(false);
  });

  test("opt-out → flexPayFn never called (header short-circuits)", async () => {
    const env = makeEnv({ withWallet: true, useFlexSplit: true });
    const c = makeContext(env, { headers: { "X-No-Sponsor": "1" } });
    let flexCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      // @ts-expect-error — seam not landed yet.
      flexPayFn: async () => {
        flexCalled = true;
        return { ok: true, authorization_id: "auth-not-fire" };
      },
    });
    expect(decision.kind).toBe("opted_out");
    expect(flexCalled).toBe(false);
  });

  test("no wallet → flexPayFn never called even with SPONSOR_USE_FLEX_SPLIT=1", async () => {
    // Wallet readiness gate still owns step 2; the Flex flag does not bypass it.
    const env = makeEnv({ withWallet: false, useFlexSplit: true });
    const c = makeContext(env);
    let flexCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      // @ts-expect-error — seam not landed yet.
      flexPayFn: async () => {
        flexCalled = true;
        return { ok: true, authorization_id: "auth-not-fire" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") expect(decision.reason).toBe("no_wallet");
    expect(flexCalled).toBe(false);
  });
});
