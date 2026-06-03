/**
 * sponsor-free-mode.test — the witness for "the platform vault takes on all costs so
 * usage is FREE + frictionless via x402, drain-safe within the global vault budget."
 *
 * Proves:
 *  - sponsorFreeMode / sponsorEffectiveAgentCapUsd pure logic (off → per-agent cap;
 *    on → global cap, i.e. the per-agent wall is lifted);
 *  - a call that the per-agent cap WOULD refuse is SPONSORED under free mode (zero
 *    friction for the user), settling on the USDC ("platform") rail;
 *  - free mode is still DRAIN-SAFE: once the global daily cap (the vault budget) is
 *    reached, further calls are refused (exhausted{global_cap}).
 *
 * No real RPC / signing — uses maybeSponsor's declared payFn seam (same as
 * sponsor-middleware.test). USD (Stripe) rail is covered by sponsor-stripe-integration.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetSponsorMiddlewareStateForTests,
  maybeSponsor,
  sponsorFreeMode,
  sponsorEffectiveAgentCapUsd,
  sponsorCapDailyUsd,
} from "../src/middleware/sponsor.js";
import type { X402PaymentRequirementV2 } from "../src/middleware/x402-gate.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";

function makeMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeEnv(opts: {
  freeMode?: boolean;
  agentCapUsd?: string;
  globalCapUsd?: string;
  kvSeed?: Record<string, string>;
}): Env {
  if (opts.kvSeed) {
    const kv = new LocalKV("stats");
    for (const [k, v] of Object.entries(opts.kvSeed)) void kv.put(k, v);
  }
  return {
    API_KEY: "test-api-key", EMERGENTDB_API_KEY: "x", NEBIUS_API_KEY: "x",
    TURBOBOX_URL: "x", FAL_KEY: "x", R2_BUCKET: {} as R2Bucket,
    STATS_KV: makeMemoryKv(), ENVIRONMENT: "local-dev",
    PLATFORM_SPONSOR_WALLET_ADDRESS: "So1PlatformVault111111111111111111111111111",
    PLATFORM_SPONSOR_WALLET_KEY: "deadbeef",
    SPONSOR_CAP_DAILY_USD: opts.agentCapUsd,
    SPONSOR_GLOBAL_DAILY_USD: opts.globalCapUsd,
    SPONSOR_FREE_MODE: opts.freeMode ? "1" : undefined,
  } as unknown as Env;
}

function makeContext(env: Env): Parameters<typeof maybeSponsor>[0] {
  return {
    env,
    req: { header: () => undefined, url: "http://localhost/v1/skills/skill-test" },
  } as unknown as Parameters<typeof maybeSponsor>[0];
}

const STD_TERMS: X402PaymentRequirementV2[] = [{
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "1000", // 1000 µ¢ = $0.001 USDC
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "So1Creator9999999999999999999999999999999999",
  maxTimeoutSeconds: 300,
}];
const FIXED = new Date("2026-06-03T10:00:00.000Z");
const DATE = "2026-06-03";

beforeEach(() => {
  _resetSponsorMiddlewareStateForTests();
  clearKVCacheForTests("stats");
});

describe("sponsor free mode — pure logic", () => {
  test("sponsorFreeMode reads 1/true, false otherwise", () => {
    expect(sponsorFreeMode({ SPONSOR_FREE_MODE: "1" })).toBe(true);
    expect(sponsorFreeMode({ SPONSOR_FREE_MODE: "true" })).toBe(true);
    expect(sponsorFreeMode({ SPONSOR_FREE_MODE: "0" })).toBe(false);
    expect(sponsorFreeMode({})).toBe(false);
  });
  test("effective per-agent cap: off → per-agent; on → global (the wall is lifted)", () => {
    expect(sponsorEffectiveAgentCapUsd({})).toBe(sponsorCapDailyUsd({})); // 1.0
    expect(sponsorEffectiveAgentCapUsd({ SPONSOR_FREE_MODE: "1" })).toBe(50.0); // global default
    expect(sponsorEffectiveAgentCapUsd({ SPONSOR_FREE_MODE: "1", SPONSOR_GLOBAL_DAILY_USD: "100" })).toBe(100);
  });
});

describe("sponsor free mode — decision", () => {
  test("OFF: an agent at the $1 per-agent cap is refused (the friction we remove)", async () => {
    const env = makeEnv({ agentCapUsd: "1.0", globalCapUsd: "50.0",
      kvSeed: { [`sponsor:agent:agent-A:${DATE}`]: "1000000" } });
    const d = await maybeSponsor(makeContext(env), STD_TERMS, "agent-A", {
      now: () => FIXED, payFn: async () => ({ success: true, signature: "nope" }),
    });
    expect(d.kind).toBe("exhausted");
    if (d.kind === "exhausted") expect(d.reason).toBe("agent_cap");
  });

  test("ON: the same maxed-out agent is SPONSORED (zero friction), USDC rail", async () => {
    const env = makeEnv({ freeMode: true, agentCapUsd: "1.0", globalCapUsd: "50.0",
      kvSeed: { [`sponsor:agent:agent-A:${DATE}`]: "1000000" } });
    let paid = false;
    const d = await maybeSponsor(makeContext(env), STD_TERMS, "agent-A", {
      now: () => FIXED,
      payFn: async () => { paid = true; return { success: true, signature: "sigPLATFORM" }; },
    });
    expect(d.kind).toBe("sponsored");
    if (d.kind === "sponsored") expect(d.method ?? "platform").toBe("platform"); // USDC rail
    expect(paid).toBe(true);
  });

  test("ON but DRAIN-SAFE: at the global vault budget, further calls are refused", async () => {
    const env = makeEnv({ freeMode: true, agentCapUsd: "1.0", globalCapUsd: "50.0",
      kvSeed: { [`sponsor:global:${DATE}`]: "50000000" } }); // $50 global already spent
    let paid = false;
    const d = await maybeSponsor(makeContext(env), STD_TERMS, "agent-B", {
      now: () => FIXED,
      payFn: async () => { paid = true; return { success: true, signature: "x" }; },
    });
    expect(d.kind).toBe("exhausted");
    if (d.kind === "exhausted") expect(d.reason).toBe("global_cap"); // vault budget bounds it
    expect(paid).toBe(false);
  });
});
