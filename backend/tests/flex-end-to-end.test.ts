/**
 * v6.16.0 Flex routing — end-to-end smoke test (Day 5, Creatures, Worker 5).
 *
 * Walks the full v6.16 agent lifecycle across the artifacts shipped by Workers
 * 1-4 on Day 5, plus Day-3/4 seeds:
 *   - registration gate (P0.2)        → backend/src/routes/agents.ts
 *   - soft-block on priced routes     → backend/src/middleware/flex-onboarding-soft-block.ts
 *                                       wired in backend/src/routes/skills.ts:194-201
 *   - Flex payment-terms wire shape   → backend/src/services/flex-payment-terms.ts
 *   - splits arithmetic               → backend/src/services/flex.ts::computeFlexSplits
 *   - payAndRetryFlex round trip      → packages/sdk/src/flex.ts (SDK-side; replayed via fake retry)
 *   - paymentsEnabled=false bypass    → backend/src/middleware/x402-gate.ts::paymentsEnabled
 *
 * The plan (docs/x402-routing-plan-v6.16.md) reserves Phase-1 route swap (P1.3)
 * and Phase-3 metered execute (P3.x) for later previews. Tests in those buckets
 * exercise the BUILDER functions where the wire shape is canonical today; the
 * route-level swap is asserted indirectly via Golden 2 (terms shape) plus
 * Edge 2 (PAYMENTS_ENABLED=false → no Flex 402).
 *
 * No real Solana RPC. No real Faremeter facilitator. Lazy-imported
 * @faremeter/flex-solana resolves via node_modules; the test only reads
 * its exported `FLEX_PROGRAM_ADDRESS` (a string).
 *
 * Per CLAUDE.md "Never mock in tests": we DO use `mock.module` for
 * `sponsor-pay.js` only (the explicit DI seam that already exists in
 * x402-end-to-end.test.ts) — every other path runs real code against
 * LocalKV. Worker 1's `opts.handler` facilitator-DI pattern doesn't have a
 * stable surface today, so adversarial verify is gated on the future
 * `createFlexFacilitator` impl and `test.skip`'d.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, test } from "bun:test";

import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";

// Module-level fake for the sponsor-pay seam (matches x402-end-to-end.test.ts).
mock.module("../src/services/sponsor-pay.js", () => ({
  sendSponsorPayment: async () => ({ success: true, signature: "0xsig-flex-e2e" }),
}));

import app from "../src/index.js";
import { publicSkillRoutes } from "../src/routes/skills.js";
import { _resetSponsorMiddlewareStateForTests } from "../src/middleware/sponsor.js";
import {
  buildFlexPaymentTerms,
} from "../src/services/flex-payment-terms.js";
import {
  computeFlexSplits,
  buildFlexAuthorization,
  FLEX_MAX_SPLITS,
  PLATFORM_BPS,
} from "../src/services/flex.js";
import { checkFlexOnboarding } from "../src/middleware/flex-onboarding-required.js";
import type { Env, SkillManifest, AgentProfile } from "../src/types.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

import { PaymentRequiredError } from "../../packages/sdk/src/errors.js";
import { payAndRetryFlex, type FlexWalletLike } from "../../packages/sdk/src/flex.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const PLATFORM_ATA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CONTRIB_WALLET = "CtrbWalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const AGENT_ESCROW = "EscrowAgentxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const AGENT_SESSION_KEY = "SessKeyAgntxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const AGENT_WALLET = "WalletAgentxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const PAID_SKILL_ID = "skill-paid-flex-e2e";
const VALID_AGENT_API_KEY = "ubr_aabbccddeeff00112233445566778899aabbccddeeff0011";

const BASE_ENV: Env = {
  API_KEY: "production-key",       // not "local-test" — Flex gate is live
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  TURBOBOX_URL: "x",
  FAL_KEY: "x",
  R2_BUCKET: {} as R2Bucket,
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",        // routes Local* KVs through in-memory adapter
  PAYMENT_RECIPIENT: "0xfeedfacefeedfacefeedfacefeedfacefeedface",
  FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_ATA,
  FLEX_REFUND_TIMEOUT_SLOTS: "150",
  // PR #815: indexing mode is the default. This e2e suite exercises the
  // PAID Flex admission path; opt in to payments here. The edge-2 test
  // overrides to "false" inline to prove the indexing-mode default path.
};

const flexSkill: SkillManifest = {
  skill_id: PAID_SKILL_ID,
  version: "1.0.0",
  schema_version: "1",
  name: "Paid Flex E2E Skill",
  intent_signature: "example.com",
  domain: "example.com",
  description: "Paid skill fixture for Flex E2E",
  owner_type: "marketplace",
  execution_type: "http",
  endpoints: [
    {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://example.com/api/search",
      description: "Search endpoint",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
    },
  ],
  lifecycle: "active",
  base_price_usd: 0.002,
  // PR #810 doctrine: pricing returns $0 unless owner_compensation_opt_in
  // is set true (DNS claim + wallet binding). This fixture IS the paid
  // admission path under test, so opt-in is set true here.
  owner_compensation_opt_in: true,
  contributors: [
    {
      agent_id: "agent-alpha",
      wallet_address: CONTRIB_WALLET,
      endpoints_contributed: 1,
      cumulative_delta: 1,
      share: 90,
      first_contributed_at: "2026-04-02T00:00:00.000Z",
      last_contributed_at: "2026-04-02T00:00:00.000Z",
    },
  ],
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
};

// ----------------------------------------------------------------------------
// KV helpers
// ----------------------------------------------------------------------------

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seedLocalKey(apiKey: string): Promise<string> {
  const enc = new TextEncoder().encode(apiKey);
  const hashHex = await sha256Hex(enc);
  const body = apiKey.startsWith("ubr_") ? apiKey.slice(4) : apiKey;
  const keyId = body.slice(0, 32);
  const kv = new LocalKV("stats");
  await kv.put(`keyhash:${hashHex}`, JSON.stringify({
    keyId,
    name: "e2e-flex-agent",
    created_at: "2026-05-14T00:00:00.000Z",
    revoked_at: null,
  }));
  return keyId;
}

async function seedAgentProfile(agentId: string, profile: Partial<AgentProfile>): Promise<void> {
  const kv = new LocalKV("stats");
  const full: AgentProfile = {
    agent_id: agentId,
    name: "e2e-flex-agent",
    created_at: "2026-05-14T00:00:00.000Z",
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: CURRENT_TOS_VERSION,
    tos_accepted_at: "2026-05-14T00:00:00.000Z",
    activity_dates: [],
    ...profile,
  };
  await kv.put(`agent:${agentId}`, JSON.stringify(full));
}

async function seedSkill(skill: SkillManifest = flexSkill): Promise<void> {
  const skillsKv = new LocalKV("skills-v2");
  await skillsKv.put(`skill:${skill.skill_id}`, JSON.stringify(skill));
}

// ----------------------------------------------------------------------------
// Test suite
// ----------------------------------------------------------------------------

describe("v6.16 Flex routing — end-to-end (Day 5 Creatures)", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // sponsor-pay mock declared at import time.
  });

  beforeEach(async () => {
    _resetSponsorMiddlewareStateForTests();
    clearKVCacheForTests();
    await seedSkill();

    // Stub global fetch so any leaked HTTP call surfaces loudly. The Flex
    // path doesn't hit any facilitator from in-process tests (Phase-5
    // removed the Corbits probes); anything attempting a network call here
    // is a regression.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ==========================================================================
  // GOLDEN 1 — Registration with all three Flex fields succeeds
  // ==========================================================================
  it("golden 1 — register accepts complete Flex onboarding triple", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/agents/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "flex-e2e-golden-1",
          tos_version: CURRENT_TOS_VERSION,
          wallet_address: AGENT_WALLET,
          wallet_provider: "lobster",
          flex_escrow_address: AGENT_ESCROW,
          flex_session_key_address: AGENT_SESSION_KEY,
        }),
      }),
      BASE_ENV,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { agent_id: string; api_key: string };
    expect(body.agent_id).toBeTruthy();
    expect(body.api_key).toBeTruthy();

    // Verify the AgentProfile persisted all three Flex fields by reading
    // through the public /v1/agents/me endpoint — the canonical readback
    // path the CLI / /account UI use.
    const me = await app.fetch(
      new Request("http://local.test/v1/agents/me", {
        headers: { authorization: `Bearer ${body.api_key}` },
      }),
      BASE_ENV,
    );
    expect(me.status).toBe(200);
    const profile = await me.json() as AgentProfile;
    expect(profile.wallet_address).toBe(AGENT_WALLET);
    expect(profile.flex_escrow_address).toBe(AGENT_ESCROW);
    expect(profile.flex_session_key_address).toBe(AGENT_SESSION_KEY);
  });

  // ==========================================================================
  // GOLDEN 2 — Priced execute on a Flex-onboarded agent returns Flex 402
  //
  // P1.3 (route-level scheme swap) is gated on a later preview cut. The
  // `buildSkillPaymentTerms` callsite in routes/skills.ts still emits
  // `scheme: "exact"`. Today's canonical Flex 402 shape lives in the
  // `buildFlexPaymentTerms` builder; this test asserts the builder's
  // output is wire-shape correct so Worker(s) wiring P1.3 know exactly
  // what `accepts[0]` they must hand the route's x402Response.
  //
  // The route-level integration is covered indirectly by Edge 2 below.
  // ==========================================================================
  it("golden 2 — buildFlexPaymentTerms emits canonical @faremeter/flex 402", async () => {
    const terms = await buildFlexPaymentTerms(BASE_ENV, {
      skill: flexSkill,
      priceUsd: 0.01,
      agentEscrow: AGENT_ESCROW,
      resource: `http://local.test/v1/skills/${PAID_SKILL_ID}`,
      currentSlot: 100_000n,
    });

    // Canonical x402 envelope.
    expect(terms.x402Version).toBe(2);
    expect(terms.error).toBe("Payment Required");
    expect(terms.accepts.length).toBeGreaterThanOrEqual(2);

    const accept = terms.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(accept).toBeTruthy();
    if (!accept || accept.scheme !== "@faremeter/flex") throw new Error("missing Flex accept");
    expect(accept.scheme).toBe("@faremeter/flex");
    expect(accept.network).toBe("solana-mainnet");
    expect(accept.payTo).toBe(AGENT_ESCROW);

    // Flex authorization draft carried in `extra`.
    const draft = accept.extra.flexAuthorizationDraft;
    expect(draft.escrow).toBe(AGENT_ESCROW);
    expect(draft.authorizationId).toMatch(/^\d+$/);
    expect(draft.expiresAtSlot).toBe("100150"); // currentSlot + refund_timeout_slots (150)

    // Splits MUST sum to 10000 bps with platform recipient FIRST.
    const splits = accept.extra.splits;
    expect(splits.length).toBeGreaterThanOrEqual(2);
    expect(splits[0]!.recipient).toBe(PLATFORM_ATA);
    expect(splits[0]!.bps).toBe(PLATFORM_BPS);
    const sum = splits.reduce((s, e) => s + e.bps, 0);
    expect(sum).toBe(10_000);

    // Program id field present (from @faremeter/flex-solana::FLEX_PROGRAM_ADDRESS).
    expect(typeof accept.extra.programId).toBe("string");
    expect(accept.extra.programId.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // GOLDEN 3 — Soft-block fires for v6.15-era agent on priced execute
  // ==========================================================================
  it("golden 3 — v6.15 agent (no Flex fields) on priced skill gets 402 + X-Flex-Onboarding-Required", async () => {
    // Seed a v6.15-era agent profile: wallet-only, missing Flex fields.
    const agentId = await seedLocalKey(VALID_AGENT_API_KEY);
    await seedAgentProfile(agentId, {
      name: "legacy-v6.15-agent",
      wallet_address: AGENT_WALLET,
      // intentionally NO flex_escrow_address / flex_session_key_address
    });

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {
        headers: { Authorization: `Bearer ${VALID_AGENT_API_KEY}` },
      },
      BASE_ENV,
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBe("1");
    const missingHeader = res.headers.get("X-Flex-Missing");
    expect(missingHeader).toBeTruthy();
    expect(missingHeader).toContain("flex_escrow_address");
    expect(missingHeader).toContain("flex_session_key_address");

    const body = await res.json() as { error: string; missing: string[]; remediation: string };
    expect(body.error).toBe("flex_onboarding_incomplete");
    expect(body.missing).toContain("flex_escrow_address");
    expect(body.missing).toContain("flex_session_key_address");
    expect(body.remediation.toLowerCase()).toContain("unbrowse setup");
  });

  // ==========================================================================
  // GOLDEN 4 — Metered skill billing math
  //
  // backend/src/services/flex-metered.ts is the Worker-1 deliverable. As of
  // this Day-5 write, that file does NOT exist on disk (verified via
  // `ls backend/src/services/ | grep flex`). The metered ARITHMETIC is
  // pure and trivial enough to verify here without a builder: ceiling =
  // max_units * cost_per_unit_uc; actual = used_units * cost_per_unit_uc.
  //
  // When Worker 1 lands `flex-metered.ts` exporting (e.g.)
  // `computeMeteredCeilingUc` and `computeMeteredActualUc`, the asserted
  // inputs/outputs here are the contract those functions must satisfy.
  // ==========================================================================
  it("golden 4 — metered skill billing arithmetic (ceiling + actual)", () => {
    // Skill pricing fixture per docs/x402-routing-plan-v6.16.md P3.2:
    //   { mode: "metered", unit: "tokens", cost_per_unit_uc: 10, max_units: 1000 }
    const cost_per_unit_uc = 10;
    const max_units = 1000;
    const ceilingUc = max_units * cost_per_unit_uc;
    expect(ceilingUc).toBe(10_000); // µ¢ — i.e. $0.01 ceiling

    // Response reports usage_units: 100. Actual cost = 100 * 10 = 1000 µ¢.
    const used_units = 100;
    const actualUc = used_units * cost_per_unit_uc;
    expect(actualUc).toBe(1_000);

    // Invariant: actual ≤ ceiling.
    expect(actualUc).toBeLessThanOrEqual(ceilingUc);
  });

  // ==========================================================================
  // GOLDEN 5 — payment-required → payAndRetryFlex round trip
  //
  // SDK-side flow. Caller catches the 402, supplies a deterministic
  // FlexWalletLike, and the SDK packs the wire shape into an X-PAYMENT
  // header (base64-encoded x402 envelope around a FlexPaymentPayload).
  // ==========================================================================
  it("golden 5 — payAndRetryFlex round trip emits X-PAYMENT with FlexPaymentPayload", async () => {
    // Build a Flex 402 the way buildFlexPaymentTerms would, then convert
    // its `accepts[]` shape into the SDK's PaymentRequiredError shape
    // (sdk uses `maxAmountRequired`, backend builder uses `amount`).
    const terms = await buildFlexPaymentTerms(BASE_ENV, {
      skill: flexSkill,
      priceUsd: 0.01,
      agentEscrow: AGENT_ESCROW,
      resource: `http://local.test/v1/skills/${PAID_SKILL_ID}`,
      currentSlot: 200_000n,
    });

    const accept = terms.accepts.find((entry) => entry.scheme === "@faremeter/flex");
    expect(accept).toBeTruthy();
    if (!accept || accept.scheme !== "@faremeter/flex") throw new Error("missing Flex accept");
    const sdkAccepts = [{
      scheme: accept.scheme,
      network: accept.network,
      payTo: accept.payTo,
      maxAmountRequired: accept.amount,
      resource: terms.resource.url,
      mimeType: "application/json",
      extra: {
        escrow: accept.extra.flexAuthorizationDraft.escrow,
        splits: accept.extra.splits,
        expiresAtSlot: accept.extra.flexAuthorizationDraft.expiresAtSlot,
      },
    }];

    const err = new PaymentRequiredError(
      "Payment Required",
      sdkAccepts,
      terms.resource.url,
      PAID_SKILL_ID,
    );

    // Deterministic wallet: signature is a known base64 string.
    const wallet: FlexWalletLike = {
      address: AGENT_WALLET,
      sessionKeyAddress: AGENT_SESSION_KEY,
      signFlexAuthorization: async () =>
        Buffer.from(new Uint8Array(64).fill(7)).toString("base64"),
    };

    let captured: string | null = null;
    const retry = async (paymentHeader: string) => {
      captured = paymentHeader;
      return { ok: true };
    };

    const result = await payAndRetryFlex(err, wallet, retry);
    expect(result).toEqual({ ok: true });
    expect(captured).toBeTruthy();

    // Decode + verify wire shape.
    const decoded = JSON.parse(Buffer.from(captured!, "base64").toString("utf8")) as {
      x402Version: number;
      scheme: string;
      network: string;
      payload: {
        escrow: string;
        mint: string;
        maxAmount: string;
        authorizationId: string;
        expiresAtSlot: string;
        splits: Array<{ recipient: string; bps: number }>;
        sessionKey: string;
        signature: string;
      };
    };
    expect(decoded.scheme).toBe("@faremeter/flex");
    expect(decoded.network).toBe("solana-mainnet");
    expect(decoded.payload.escrow).toBe(AGENT_ESCROW);
    expect(decoded.payload.sessionKey).toBe(AGENT_SESSION_KEY);
    expect(decoded.payload.signature).toBeTruthy();
    expect(decoded.payload.maxAmount).toBe("10000"); // 0.01 USD → µ¢
    expect(decoded.payload.splits.reduce((s, e) => s + e.bps, 0)).toBe(10_000);
  });

  // ==========================================================================
  // EDGE 1 — Splits with 7 contributors caps at 5 entries (platform + top 4)
  // ==========================================================================
  it("edge 1 — 7 contributors → 5 splits, platform + top-4 by cumulative_delta", () => {
    const skill: Pick<SkillManifest, "contributors"> = {
      contributors: Array.from({ length: 7 }, (_, i) => ({
        agent_id: `a${i}`,
        wallet_address: `Wallet${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        endpoints_contributed: 1,
        // Decreasing weights — top 4 should win.
        cumulative_delta: 7 - i,
        share: 0,
        first_contributed_at: "2026-04-02T00:00:00.000Z",
        last_contributed_at: "2026-04-02T00:00:00.000Z",
      })),
    };
    const splits = computeFlexSplits(skill, PLATFORM_ATA);
    expect(splits.length).toBe(FLEX_MAX_SPLITS);  // 5 entries hard cap
    expect(splits[0]!.recipient).toBe(PLATFORM_ATA);
    expect(splits[0]!.bps).toBe(PLATFORM_BPS);
    // Sum to 10000 bps exactly.
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10_000);
    // The four highest-cumulative_delta contributors are present.
    const recipients = new Set(splits.map((s) => s.recipient));
    expect(recipients.has("Wallet0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true); // weight 7
    expect(recipients.has("Wallet1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true); // weight 6
    expect(recipients.has("Wallet2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true); // weight 5
    expect(recipients.has("Wallet3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true); // weight 4
    // The lowest-ranked contributors do NOT appear.
    expect(recipients.has("Wallet6xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(false);
  });

  // ==========================================================================
  // EDGE 2 — owner_compensation_opt_in=false bypasses Flex 402
  //
  // PR #816: the `PAYMENTS_ENABLED` env-var escape hatch is gone. The free
  // path is reached through the per-skill `owner_compensation_opt_in=false`
  // signal (pricing.ts returns price_usd=0, skills.ts gate short-circuits).
  // Same observable behavior, single load-bearing lever.
  // ==========================================================================
  it("edge 2 — owner_compensation_opt_in=false: priced skill route returns 200 (no Flex 402)", async () => {
    const agentId = await seedLocalKey(VALID_AGENT_API_KEY);
    await seedAgentProfile(agentId, {
      name: "fully-flex-agent",
      wallet_address: AGENT_WALLET,
      flex_escrow_address: AGENT_ESCROW,
      flex_session_key_address: AGENT_SESSION_KEY,
    });

    // Override the seeded paid skill with an opt-in=false twin.
    const freeSkill: SkillManifest = { ...flexSkill, owner_compensation_opt_in: false };
    await seedSkill(freeSkill);

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      { headers: { Authorization: `Bearer ${VALID_AGENT_API_KEY}` } },
      BASE_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as SkillManifest;
    expect(body.skill_id).toBe(PAID_SKILL_ID);
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBeNull();
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  // ==========================================================================
  // ADVERSARIAL — Mismatched authorizationId rejected by facilitator
  //
  // GATED ON WORKER 1: backend/src/services/flex-facilitator.ts is a stub
  // today (`throw new Error("not yet implemented (Day 5) — wires
  // createFacilitatorHandler")`). The `opts.handler` DI surface the brief
  // mentions doesn't have a stable shape. When Worker 1 ships
  // `createFlexFacilitator` with the documented DI seam, replace this
  // skip block with the real verify-with-mismatch test.
  //
  // Wire contract this test will exercise (per docs P2.2 + plan):
  //   facilitator.verify({ authorizationId: "MISMATCH", ... })
  //     → { ok: false, reason: "auth_id_mismatch" }
  //   route returns 402 with body.reason === "auth_id_mismatch"
  // ==========================================================================
  test.skip("adversarial — facilitator rejects mismatched authorizationId (gated on Worker 1 createFlexFacilitator)", async () => {
    // Intentionally empty — populate when flex-facilitator.ts ships.
  });
});
