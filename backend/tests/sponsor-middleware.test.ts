/**
 * Day 4 (Genesis Luminaries) test matrix for the sponsor middleware.
 *
 * Six cases on maybeSponsor:
 *   1. no_wallet           — env missing → exhausted{no_wallet}
 *   2. opted_out           — X-No-Sponsor:1 → opted_out
 *   3. agent_cap_hit       — agent already at $1.00 today → exhausted{agent_cap}
 *   4. global_cap_hit      — platform at $50.00 today → exhausted{global_cap}
 *   5. sponsored_happy     — caps OK, payFn returns signature → sponsored
 *   6. payment_send_fails  — payFn throws → exhausted{no_wallet}, no rethrow
 *
 * Plus the original 5 pure-helper tests retained from Day 3.
 *
 * No real RPC, no real Solana signing — `maybeSponsor` accepts an opt-in
 * `payFn` test seam. Per CLAUDE.md "Never mock in tests" doctrine: this is
 * the explicit dependency-injection seam the production code declares, not a
 * runtime monkey-patch. The TEST fakes USDC payment ONLY; everything else
 * (env reads, KV writes, header inspection, decision union) runs real.
 *
 * KV storage uses `ENVIRONMENT="local-dev"` so the middleware's `statsKV(env)`
 * call returns the in-process LocalKV (no EmergentDB / no Pg). We seed and
 * verify side effects against that same LocalKV namespace.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetSponsorMiddlewareStateForTests,
  maybeSponsor,
  sponsorCapDailyUsd,
  sponsorGlobalCapDailyUsd,
  sponsorWalletReady,
  type SponsorEnv,
} from "../src/middleware/sponsor.js";
import type { X402PaymentRequirementV2 } from "../src/middleware/x402-gate.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";

// --- Pure-helper tests retained from Day 3 -----------------------------------

describe("sponsor middleware — pure helpers", () => {
  test("sponsorWalletReady is false when address is missing", () => {
    const env: SponsorEnv = { PLATFORM_SPONSOR_WALLET_KEY: "key123" };
    expect(sponsorWalletReady(env)).toBe(false);
  });

  test("sponsorWalletReady is false when key is missing", () => {
    const env: SponsorEnv = { PLATFORM_SPONSOR_WALLET_ADDRESS: "So1abc" };
    expect(sponsorWalletReady(env)).toBe(false);
  });

  test("sponsorWalletReady is true when both address and key are set", () => {
    const env: SponsorEnv = {
      PLATFORM_SPONSOR_WALLET_ADDRESS: "So1abc",
      PLATFORM_SPONSOR_WALLET_KEY: "key123",
    };
    expect(sponsorWalletReady(env)).toBe(true);
  });

  test("sponsorCapDailyUsd defaults to 1.0 when env var is unset", () => {
    expect(sponsorCapDailyUsd({})).toBe(1.0);
  });

  test("sponsorCapDailyUsd parses '2.5' to 2.5", () => {
    expect(sponsorCapDailyUsd({ SPONSOR_CAP_DAILY_USD: "2.5" })).toBe(2.5);
  });

  test("sponsorGlobalCapDailyUsd defaults to 50.0", () => {
    expect(sponsorGlobalCapDailyUsd({})).toBe(50.0);
  });
});

// --- Test fixtures -----------------------------------------------------------

/** Simple KV-shaped object — only the methods the middleware uses. */
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
}): Env {
  // Seed the in-process LocalKV (used by statsKV when ENVIRONMENT="local-dev")
  // with the provided rollup keys. The middleware reads via statsKV, so the
  // LocalKV namespace is where seeds and side-effect writes both land.
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
    PAYMENTS_ENABLED: "true",
    PLATFORM_SPONSOR_WALLET_ADDRESS: opts.withWallet
      ? "So1PlatformWallet1111111111111111111111111111"
      : undefined,
    PLATFORM_SPONSOR_WALLET_KEY: opts.withWallet ? "deadbeef" : undefined,
    SPONSOR_CAP_DAILY_USD: opts.agentCapUsd,
    SPONSOR_GLOBAL_DAILY_USD: opts.globalCapUsd,
  };
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
  // Clear the LocalKV "stats" namespace so each test starts with no rollups.
  clearKVCacheForTests("stats");
});

// --- Day 4 6-case decision matrix --------------------------------------------

describe("sponsor middleware — decision matrix (Day 4)", () => {
  test("1. no_wallet — env missing returns exhausted{no_wallet}", async () => {
    const env = makeEnv({ withWallet: false });
    const c = makeContext(env);
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A");
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("no_wallet");
      expect(decision.remaining_credit_usd).toBe(0);
    }
  });

  test("2. opted_out — X-No-Sponsor:1 short-circuits before wallet check", async () => {
    const env = makeEnv({ withWallet: true });
    const c = makeContext(env, { headers: { "X-No-Sponsor": "1" } });
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A");
    expect(decision.kind).toBe("opted_out");
  });

  test("3. agent_cap_hit — agent already at $1.00 today returns exhausted{agent_cap}", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const dateStr = "2026-05-14";
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      globalCapUsd: "50.0",
      kvSeed: { [`sponsor:agent:agent-A:${dateStr}`]: "1000000" },
    });
    const c = makeContext(env);
    let payFnCalled = false;
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async () => {
        payFnCalled = true;
        return { success: true, signature: "should-not-be-called" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("agent_cap");
      expect(decision.remaining_credit_usd).toBe(0);
    }
    expect(payFnCalled).toBe(false);
  });

  test("4. global_cap_hit — platform at $50.00 today returns exhausted{global_cap}", async () => {
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
        return { success: true, signature: "should-not-be-called" };
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("global_cap");
      expect(decision.remaining_credit_usd).toBe(0);
    }
    expect(payFnCalled).toBe(false);
  });

  test("5. sponsored_happy — caps OK, payFn returns sig, decision is sponsored with tx_hash + ledger_id", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      globalCapUsd: "50.0",
    });
    const c = makeContext(env);
    let payFnArgs: { recipient?: string; amount?: number } = {};
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async (_env, recipient, amount) => {
        payFnArgs = { recipient, amount };
        return { success: true, signature: "0xabcDEF123signature" };
      },
    });
    expect(decision.kind).toBe("sponsored");
    if (decision.kind === "sponsored") {
      expect(decision.tx_hash).toBe("0xabcDEF123signature");
      expect(decision.amount_usdc).toBe("1000");
      expect(decision.ledger_id).toMatch(/^spr-2026-05-14-[a-f0-9]{8}$/);
      // Remaining = $1.00 cap - $0.001 spend = $0.999
      expect(decision.remaining_credit_usd).toBeCloseTo(0.999, 5);
    }
    expect(payFnArgs.recipient).toBe("So1Creator9999999999999999999999999999999999");
    expect(payFnArgs.amount).toBe(1000);

    // Side-effect verification: rollup keys + ledger row landed in the same
    // LocalKV the middleware wrote to (statsKV(env) when ENVIRONMENT=local-dev).
    const localKv = new LocalKV("stats");
    const agentSpend = (await localKv.get("sponsor:agent:agent-A:2026-05-14")) as string | null;
    const globalSpend = (await localKv.get("sponsor:global:2026-05-14")) as string | null;
    expect(agentSpend).toBe("1000");
    expect(globalSpend).toBe("1000");
    if (decision.kind === "sponsored") {
      const ledgerRow = (await localKv.get(`sponsor:ledger:${decision.ledger_id}`)) as string | null;
      expect(ledgerRow).not.toBeNull();
      const parsed = JSON.parse(ledgerRow!) as {
        kind: string; agent_id: string; skill_id: string;
        amount_uc: number; creator_wallet: string; settled_tx: string;
      };
      expect(parsed.kind).toBe("sponsor");
      expect(parsed.agent_id).toBe("agent-A");
      expect(parsed.skill_id).toBe("skill-test");
      expect(parsed.amount_uc).toBe(1000);
      expect(parsed.creator_wallet).toBe("So1Creator9999999999999999999999999999999999");
      expect(parsed.settled_tx).toBe("0xabcDEF123signature");
    }
  });

  test("6. payment_send_fails — payFn throwing returns exhausted{no_wallet} and never re-throws", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const env = makeEnv({
      withWallet: true,
      agentCapUsd: "1.0",
      globalCapUsd: "50.0",
    });
    const c = makeContext(env);
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async () => {
        throw new Error("rpc unreachable: simulated");
      },
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("no_wallet");
    }
    // Confirm no rollup leaked through on the failure path.
    const localKv = new LocalKV("stats");
    const agentSpend = (await localKv.get("sponsor:agent:agent-A:2026-05-14")) as string | null;
    expect(agentSpend).toBeNull();
  });

  test("6b. payment_send_returns_failure — graceful exhausted, never throws", async () => {
    const fixedDate = new Date("2026-05-14T10:00:00.000Z");
    const env = makeEnv({ withWallet: true });
    const c = makeContext(env);
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A", {
      now: () => fixedDate,
      payFn: async () => ({ success: false, error: "insufficient signer balance" }),
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("no_wallet");
    }
  });
});
