/**
 * Public skill x402 route — Flex envelope shape (v6.16, Day-5).
 *
 * v6.15 emitted a Corbits-shaped envelope (scheme `exact`, accepts[] over two
 * chains, payTo = contributor wallet). v6.16 swaps the terms builder to
 * `buildFlexPaymentTerms` so the envelope now carries `scheme: @faremeter/flex`,
 * a single solana-mainnet accepts[] entry, `payTo = agent's escrow PDA`, and
 * `extra.splits` summing to 10000 bps with the platform at 1000.
 *
 * The anonymous-caller path returns `flex_escrow_required` (402) since no
 * agent identity = no escrow PDA to author a Flex authorization against. The
 * authenticated path with a seeded `flex_escrow_address` returns the Flex
 * envelope.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publicSkillRoutes } from "../src/routes/skills.js";
import { clearSupportedKindsCacheForTests, x402UseTestnet } from "../src/middleware/x402-gate.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { Env, SkillManifest, AgentProfile } from "../src/types.js";

const PAID_SKILL_ID = "skill-paid-x402";
// 48 hex chars body so verifyLocalKey's prefix + sha256 path works.
const VALID_AGENT_API_KEY = "ubr_aabbccddeeff00112233445566778899aabbccddeeff0011";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
  PAYMENT_RECIPIENT: "0xfeedfacefeedfacefeedfacefeedfacefeedface",
  FLEX_PLATFORM_RECIPIENT_USDC_ATA: "PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  FLEX_REFUND_TIMEOUT_SLOTS: "150",
};

const paidSkill: SkillManifest = {
  skill_id: PAID_SKILL_ID,
  version: "1.0.0",
  schema_version: "1",
  name: "Example Skill",
  intent_signature: "example.com",
  domain: "example.com",
  description: "Paid skill fixture",
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
      wallet_address: "So1anaContributor1111111111111111111111111111",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Seed an agent profile (with optional flex_escrow_address) for the keyId
 *  derived from VALID_AGENT_API_KEY. Returns the keyId. */
async function seedAgentWithFlex(opts: { withEscrow: boolean }): Promise<string> {
  const enc = new TextEncoder().encode(VALID_AGENT_API_KEY);
  const hashHex = await sha256Hex(enc);
  const body = VALID_AGENT_API_KEY.slice(4);
  const keyId = body.slice(0, 32);
  const kv = new LocalKV("stats"); // local-dev namespace
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
    wallet_address: "WalletXXXXXXXXXXXXXXXXXXXXXXXX",
    flex_session_key_address: "SessKeyXXXXXXXXXXXXXXXXXXXXXXXX",
    ...(opts.withEscrow ? { flex_escrow_address: "EscrowPdaXXXXXXXXXXXXXXXXXXXXXX" } : {}),
    skills_discovered: [],
    total_executions: 0,
    total_feedback_given: 0,
    tos_accepted_version: "v1",
    tos_accepted_at: "2026-05-14T00:00:00.000Z",
  };
  await kv.put(`agent:${keyId}`, JSON.stringify(profile));
  return keyId;
}

async function seedSkill(): Promise<void> {
  const skillsKv = new LocalKV("skills-v2"); // local-dev namespace
  await skillsKv.put(`skill:${PAID_SKILL_ID}`, JSON.stringify(paidSkill));
}

describe("public skill x402 route — Flex envelope (v6.16)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    clearSupportedKindsCacheForTests();
    clearKVCacheForTests();
    await seedSkill();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // No external Corbits traffic expected on the Flex emit path.
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns Flex envelope when agent is fully onboarded (has flex_escrow_address)", async () => {
    await seedAgentWithFlex({ withEscrow: true });

    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      { headers: { Authorization: `Bearer ${VALID_AGENT_API_KEY}` } },
      BASE_ENV,
    );
    const body = await res.json() as {
      x402Version: number;
      error: string;
      accepts: Array<{
        scheme: string;
        network: string;
        amount: string;
        payTo: string;
        extra: { splits: Array<{ recipient: string; bps: number }>; programId: string };
      }>;
    };

    expect(res.status).toBe(402);
    expect(body.error).toBe("Payment Required");
    expect(body.x402Version).toBe(2);
    expect(body.accepts.length).toBe(1);
    expect(body.accepts[0].scheme).toBe("@faremeter/flex");
    expect(body.accepts[0].network).toBe("solana-mainnet");
    // payTo is the agent's flex_escrow_address, not the contributor wallet.
    expect(body.accepts[0].payTo).toBe("EscrowPdaXXXXXXXXXXXXXXXXXXXXXX");
    // splits sum to 10000 bps with platform at 1000.
    const splits = body.accepts[0].extra.splits;
    const total = splits.reduce((s, e) => s + e.bps, 0);
    expect(total).toBe(10000);
    expect(splits[0].recipient).toBe("PlatformATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(splits[0].bps).toBe(1000);
  });

  it("returns flex_onboarding_incomplete when agent profile is missing flex_escrow_address", async () => {
    // Seed agent WITHOUT flex_escrow_address — soft-block middleware fires.
    await seedAgentWithFlex({ withEscrow: false });

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

  it("returns flex_escrow_required for anonymous callers (no agent identity)", async () => {
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      BASE_ENV,
    );
    const body = await res.json() as { error: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe("flex_escrow_required");
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBe("1");
  });

  it("disables skill payments entirely when PAYMENTS_ENABLED=false", async () => {
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      { ...BASE_ENV, PAYMENTS_ENABLED: "false" },
    );
    const body = await res.json() as SkillManifest;

    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body.skill_id).toBe(PAID_SKILL_ID);
  });

  it("keeps paid skill detail gated when X402_SEARCH_ENABLED=false (skill price overrides search flag)", async () => {
    const res = await publicSkillRoutes.request(
      `http://localhost/skills/${PAID_SKILL_ID}`,
      {},
      { ...BASE_ENV, X402_SEARCH_ENABLED: "false" },
    );

    expect(res.status).toBe(402);
    // Anonymous → flex_escrow_required (not Flex envelope).
    const body = await res.json() as { error: string };
    expect(body.error).toBe("flex_escrow_required");
  });
});

describe("x402UseTestnet (unchanged)", () => {
  it("defaults staging to testnet and production to mainnet", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "staging" })).toBe(true);
    expect(x402UseTestnet({ ENVIRONMENT: "production" })).toBe(false);
  });

  it("allows explicit network override", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "staging", X402_NETWORK_MODE: "mainnet" })).toBe(false);
    expect(x402UseTestnet({ ENVIRONMENT: "production", X402_NETWORK_MODE: "testnet" })).toBe(true);
  });
});
