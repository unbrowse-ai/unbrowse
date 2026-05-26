/**
 * Day 5 (Genesis Creatures) Worker-2 route-swap acceptance tests.
 *
 * Proves the priced skill route emits the Flex envelope (golden) and falls
 * back to the defensive `flex_escrow_required` 402 when the agent's
 * `flex_escrow_address` is missing. The X-PAYMENT (signed Flex authorization)
 * path is exercised against a stubbed facilitator handler.
 *
 * No real Solana RPC, no Faremeter init. Stubs the facilitator via the DI
 * seam in `createFlexFacilitator(env, { handler })`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { FlexFacilitatorHandler } from "../src/services/flex-facilitator.js";

const PLATFORM_USDC_ATA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const facilitatorState: {
  mode: "valid" | "invalid_sig" | "throw" | "settle_fail";
} = { mode: "valid" };

const stubHandler: FlexFacilitatorHandler = {
  getSupported: () => [Promise.resolve({ x402Version: 2, scheme: "@faremeter/flex", network: "solana-mainnet" })],
  getRequirements: async () => [],
  handleVerify: async () => {
    if (facilitatorState.mode === "invalid_sig") {
      return { isValid: false, invalidReason: "signature_mismatch" };
    }
    if (facilitatorState.mode === "throw") throw new Error("rpc unreachable (stub)");
    return { isValid: true, payer: "PayerStubXXXXXXXXXXXXXXXXXXXXXXXXX" };
  },
  handleSettle: async () => {
    if (facilitatorState.mode === "settle_fail") {
      return { success: false, transaction: "", network: "solana", errorReason: "stubbed" };
    }
    return {
      success: true,
      transaction: "TxSigStubXXXXXXXXXXXXXXXXXXXXXXXXX",
      network: "solana",
      payer: "PayerStubXXXXXXXXXXXXXXXXXXXXXXXXX",
    };
  },
  flush: async () => [],
  stop: () => {},
};

// Swap the facilitator factory so the route's `createFlexFacilitator(env)`
// call resolves to our stub (no Solana RPC, no Faremeter init).
mock.module("../src/services/flex-facilitator.js", () => ({
  createFlexFacilitator: async () => ({
    handler: stubHandler,
    flush: async () => ({ submitted: 0, finalized: 0, results: [] }),
    stop: async () => {},
    supported: async () => [],
  }),
  resetFlexFacilitatorCacheForTests: () => {},
  platformRecipientUsdcAta: (env: { FLEX_PLATFORM_RECIPIENT_USDC_ATA?: string }) =>
    env.FLEX_PLATFORM_RECIPIENT_USDC_ATA ?? PLATFORM_USDC_ATA,
  flexRefundTimeoutSlots: () => 150n,
}));

import { publicSkillRoutes } from "../src/routes/skills.js";
import type { Env, SkillManifest, AgentProfile } from "../src/types.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

const PAID_SKILL_ID = "skill-flex-swap";
const VALID_AGENT_API_KEY = "ubr_aabbccddeeff00112233445566778899aabbccddeeff0011";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
  PAYMENT_RECIPIENT: "0xplatformwallet",
  FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_USDC_ATA,
  FLEX_REFUND_TIMEOUT_SLOTS: "150",
  // PR #815: indexing mode default; this suite exercises paid Flex.
  PAYMENTS_ENABLED: "true",
  X402_SEARCH_ENABLED: "true",
};

const paidSkill: SkillManifest = {
  skill_id: PAID_SKILL_ID,
  version: "1.0.0",
  schema_version: "1",
  name: "Flex Swap Fixture",
  intent_signature: "example.com",
  domain: "example.com",
  description: "Flex-priced skill fixture",
  owner_type: "marketplace",
  execution_type: "http",
  endpoints: [{
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://example.com/api",
    description: "endpoint",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
  }],
  lifecycle: "active",
  base_price_usd: 0.01,
  // PR #810: pricing returns $0 unless owner_compensation_opt_in. Paid path under test.
  owner_compensation_opt_in: true,
  contributors: [{
    agent_id: "agent-alpha",
    wallet_address: "WalletContrib1111111111111111111111111111111",
    endpoints_contributed: 1,
    cumulative_delta: 1,
    share: 90,
    first_contributed_at: "2026-04-02T00:00:00.000Z",
    last_contributed_at: "2026-04-02T00:00:00.000Z",
  }],
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
};

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seedAgent(opts: { withEscrow: boolean }): Promise<string> {
  const enc = new TextEncoder().encode(VALID_AGENT_API_KEY);
  const hashHex = await sha256Hex(enc);
  const keyId = VALID_AGENT_API_KEY.slice(4).slice(0, 32);
  const kv = new LocalKV("stats");
  await kv.put(`keyhash:${hashHex}`, JSON.stringify({
    keyId,
    name: "flex-test-agent",
    created_at: "2026-05-14T00:00:00.000Z",
    revoked_at: null,
  }));
  const profile: AgentProfile = {
    agent_id: keyId,
    name: "flex-test-agent",
    created_at: "2026-05-14T00:00:00.000Z",
    wallet_address: "WalletPaired11111111111111111111111111111111",
    flex_session_key_address: "SessKey11111111111111111111111111111111111111",
    ...(opts.withEscrow ? { flex_escrow_address: "EscrowPda1111111111111111111111111111111111" } : {}),
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: CURRENT_TOS_VERSION,
    tos_accepted_at: "2026-05-14T00:00:00.000Z",
  };
  await kv.put(`agent:${keyId}`, JSON.stringify(profile));
  return keyId;
}

async function seedSkill(): Promise<void> {
  const kv = new LocalKV("skills-v2");
  await kv.put(`skill:${PAID_SKILL_ID}`, JSON.stringify(paidSkill));
}

describe("Day 5 — Flex route swap (skills.ts)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    clearKVCacheForTests();
    facilitatorState.mode = "valid";
    await seedSkill();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("golden: full Flex onboarding → 402 with @faremeter/flex envelope", async () => {
    await seedAgent({ withEscrow: true });

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      { headers: { Authorization: `Bearer ${VALID_AGENT_API_KEY}` } },
      BASE_ENV,
    );
    const body = await res.json() as {
      x402Version: number;
      accepts: Array<{
        scheme: string;
        network: string;
        amount: string;
        payTo: string;
        extra: {
          splits: Array<{ recipient: string; bps: number }>;
          flexAuthorizationDraft: { escrow: string; maxAmount: string; authorizationId: string };
          programId: string;
        };
      }>;
    };

    expect(res.status).toBe(402);
    expect(body.x402Version).toBe(2);
    expect(body.accepts.length).toBeGreaterThanOrEqual(2);
    const flex = body.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(flex).toBeTruthy();
    if (!flex) throw new Error("missing Flex accept");
    expect(flex.network).toBe("solana-mainnet");
    // payTo is the agent's escrow PDA, not the contributor wallet.
    expect(flex.payTo).toBe("EscrowPda1111111111111111111111111111111111");
    // splits sum to 10000 bps, platform present at the current default cut.
    const splits = flex.extra.splits;
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
    expect(splits[0].recipient).toBe(PLATFORM_USDC_ATA);
    expect(splits[0].bps).toBe(5000);
    expect(flex.extra.flexAuthorizationDraft.escrow).toBe("EscrowPda1111111111111111111111111111111111");
    // amount is dynamic from computeRoutePrice; just assert it's a positive
    // integer string and matches the embedded maxAmount.
    expect(Number(flex.amount)).toBeGreaterThan(0);
    expect(flex.extra.flexAuthorizationDraft.maxAmount).toBe(flex.amount);
  });

  it("edge: agent missing flex_escrow_address → soft-block 402 with flex_onboarding_incomplete", async () => {
    await seedAgent({ withEscrow: false });

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      { headers: { Authorization: `Bearer ${VALID_AGENT_API_KEY}` } },
      BASE_ENV,
    );
    const body = await res.json() as { error: string; missing?: string[] };

    expect(res.status).toBe(402);
    expect(body.error).toBe("flex_onboarding_incomplete");
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBe("1");
  });

  it("adversarial: facilitator rejects authorization → 402 with flex_verify_failed", async () => {
    await seedAgent({ withEscrow: true });
    facilitatorState.mode = "invalid_sig";

    const payment = JSON.stringify({
      accepted: { scheme: "@faremeter/flex", network: "solana-mainnet" },
      payload: { authorizationId: "999", signature: "bogus" },
    });

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {
        headers: {
          Authorization: `Bearer ${VALID_AGENT_API_KEY}`,
          "X-PAYMENT": payment,
        },
      },
      BASE_ENV,
    );
    const body = await res.json() as { error: string; reason?: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe("flex_verify_failed");
    expect(body.reason).toBe("signature_mismatch");
  });

  it("adversarial: malformed X-PAYMENT (garbage bytes) → 402 with malformed_payload", async () => {
    await seedAgent({ withEscrow: true });
    facilitatorState.mode = "valid";

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {
        headers: {
          Authorization: `Bearer ${VALID_AGENT_API_KEY}`,
          "X-PAYMENT": "###not-json-or-base64###",
        },
      },
      BASE_ENV,
    );
    const body = await res.json() as { error: string; reason?: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe("flex_verify_failed");
    expect(body.reason).toBe("malformed_payload");
  });
});
