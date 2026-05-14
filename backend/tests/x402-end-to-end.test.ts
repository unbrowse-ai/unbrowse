/**
 * Day 4 (Genesis Luminaries) end-to-end x402 + sponsor integration test.
 *
 * Boots the public skill route surface (mirrors `tests/x402-skill-route.test.ts`)
 * and exercises the Flex + sponsor paths:
 *   1. No payment, no sponsor headers, no API key       → 402, flex_escrow_required
 *   2. X-No-Sponsor:1 with valid api key                 → 402, X-Sponsor-Reason=opted_out
 *   3. API key + sponsor wallet env wired, mocked payFn  → 200, X-Sponsored set
 *
 * Uses `ENVIRONMENT="local-dev"` so `statsKV(env)` and `skillsKV(env)` return
 * the in-process LocalKV — we seed the same Maps the route reads from. The
 * sponsor-pay module is stubbed; no real Solana RPC, no real facilitator. The
 * legacy Corbits PAYMENT-SIGNATURE settle path was removed in v6.16 Phase 5
 * (Day-6, Genesis Dominion) — its prior coverage lives in `tests/flex-end-to-
 * end.test.ts` against the Flex facilitator instead.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";

// Stub the sponsor-pay module FIRST so the route's dynamic import resolves
// to our stub rather than the real Solana signer. mock.module is per-process
// and persists for this file. Use a controllable global flag so we can flip
// success/failure per test.
const sponsorPayState: { mode: "success" | "throw" | "fail"; signature?: string } = {
  mode: "success",
  signature: "0xsig-e2e-default",
};
mock.module("../src/services/sponsor-pay.js", () => ({
  sendSponsorPayment: async (
    _env: unknown,
    _recipient: string,
    _amountUc: number,
  ) => {
    if (sponsorPayState.mode === "throw") throw new Error("rpc unreachable (test stub)");
    if (sponsorPayState.mode === "fail") return { success: false, error: "stubbed failure" };
    return { success: true, signature: sponsorPayState.signature ?? "0xsig-default" };
  },
}));

import { publicSkillRoutes } from "../src/routes/skills.js";
import {
  _resetSponsorMiddlewareStateForTests,
} from "../src/middleware/sponsor.js";
import type { Env, SkillManifest } from "../src/types.js";

const PAID_SKILL_ID = "skill-paid-e2e";
// 48 hex chars body so verifyLocalKey's prefix + sha256 path works.
const VALID_AGENT_API_KEY = "ubr_aabbccddeeff00112233445566778899aabbccddeeff0011";
const CONTRIBUTOR_WALLET = "So1aE2eContributor1111111111111111111111111";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  TURBOBOX_URL: "x",
  FAL_KEY: "x",
  R2_BUCKET: {} as R2Bucket,
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
  PAYMENT_RECIPIENT: "0xfeedfacefeedfacefeedfacefeedfacefeedface",
};

const paidSkill: SkillManifest = {
  skill_id: PAID_SKILL_ID,
  version: "1.0.0",
  schema_version: "1",
  name: "Paid E2E Skill",
  intent_signature: "example.com",
  domain: "example.com",
  description: "Paid skill fixture for sponsor E2E",
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
  contributors: [
    {
      agent_id: "agent-alpha",
      wallet_address: CONTRIBUTOR_WALLET,
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


/** Compute SHA-256 hex matching services/keys.ts::sha256Hex. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Seed the local-dev stats KV so verifyLocalKey resolves the bearer to a
 *  non-admin keyId (= agent_id used by the route's admission shortcut). */
async function seedLocalKey(apiKey: string): Promise<string> {
  const enc = new TextEncoder().encode(apiKey);
  const hashHex = await sha256Hex(enc);
  const body = apiKey.startsWith("ubr_") ? apiKey.slice(4) : apiKey;
  const keyId = body.slice(0, 32);
  const kv = new LocalKV("stats"); // ENVIRONMENT=local-dev → "stats" namespace.
  await kv.put(`keyhash:${hashHex}`, JSON.stringify({
    keyId,
    name: "e2e-agent",
    created_at: "2026-05-14T00:00:00.000Z",
    revoked_at: null,
  }));
  return keyId;
}

/** Seed the local-dev skills KV with our paid skill fixture. */
async function seedSkill(): Promise<void> {
  const skillsKv = new LocalKV("skills-v2"); // local-dev namespace.
  await skillsKv.put(`skill:${PAID_SKILL_ID}`, JSON.stringify(paidSkill));
}

beforeAll(async () => {
  // No-op — module mock declared at import time.
});

describe("x402 + sponsor end-to-end (Day 4 C2)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    _resetSponsorMiddlewareStateForTests();
    clearKVCacheForTests();
    // Fresh seed before each test.
    await seedSkill();
    // Default sponsor stub: success with deterministic signature.
    sponsorPayState.mode = "success";
    sponsorPayState.signature = "0xsig-e2e-default";

    // No facilitator HTTP traffic should fire from these test paths
    // (anonymous → flex_escrow_required, opted-out → 402, sponsor admit →
    // 200 via mocked sponsor-pay). Any leaked fetch is a regression.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("test 1 — no payment, no sponsor headers, anonymous: 402 with flex_escrow_required", async () => {
    // v6.16 swap: anonymous callers (no agent identity) can't author a Flex
    // authorization, so the defensive guard in respondWithFlexTerms returns
    // 402 with `flex_escrow_required` instead of the legacy Corbits accepts[].
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      BASE_ENV,
    );

    expect(res.status).toBe(402);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("flex_escrow_required");
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBe("1");
    // Anonymous path — no sponsor headers should appear.
    expect(res.headers.get("X-Sponsored")).toBeNull();
    expect(res.headers.get("X-Sponsor-Exhausted")).toBeNull();
  });

  it("test 2 — X-No-Sponsor:1 with valid api key: 402 with X-Sponsor-Reason=opted_out", async () => {
    await seedLocalKey(VALID_AGENT_API_KEY);

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {
        headers: {
          "Authorization": `Bearer ${VALID_AGENT_API_KEY}`,
          "X-No-Sponsor": "1",
        },
      },
      {
        ...BASE_ENV,
        // Sponsor wallet wired so opt-out fires *before* the wallet check.
        PLATFORM_SPONSOR_WALLET_ADDRESS: "So1PlatformWallet1111111111111111111111111111",
        PLATFORM_SPONSOR_WALLET_KEY: "deadbeef",
      },
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("X-Sponsored")).toBeNull();
    expect(res.headers.get("X-Sponsor-Reason")).toBe("opted_out");
  });

  it("test 3 — sponsor env wired, caps fresh: 200 + X-Sponsored header", async () => {
    await seedLocalKey(VALID_AGENT_API_KEY);
    sponsorPayState.signature = "0xsig-e2e-sponsor-3";

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {
        headers: { "Authorization": `Bearer ${VALID_AGENT_API_KEY}` },
      },
      {
        ...BASE_ENV,
        PLATFORM_SPONSOR_WALLET_ADDRESS: "So1PlatformWallet1111111111111111111111111111",
        PLATFORM_SPONSOR_WALLET_KEY: "deadbeef",
        SPONSOR_CAP_DAILY_USD: "1.0",
        SPONSOR_GLOBAL_DAILY_USD: "50.0",
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sponsored")).toBeTruthy();
    expect(res.headers.get("X-Sponsor-Tx")).toBe("0xsig-e2e-sponsor-3");
    const remaining = res.headers.get("X-Sponsor-Remaining-Usd");
    expect(remaining).toBeTruthy();
    // Body should be the skill (sponsor admit serves the resource).
    const body = await res.json() as SkillManifest;
    expect(body.skill_id).toBe(PAID_SKILL_ID);
  });
});
