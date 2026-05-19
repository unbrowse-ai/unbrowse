/**
 * Per-call proxy-surcharge surface for the 429-paid-fallback feature.
 *
 * Verifies recordProxySurcharge() writes a kind:"sponsor" ledger row with
 * surcharge_reason:"proxy_429_fallback", increments the separate
 * sponsor:proxy-surcharge:<agent>:<UTC-date> counter, is idempotent on
 * ledger_id, and does NOT touch the base sponsor:agent counter (so the
 * existing daily cap math stays intact).
 *
 * All tests FAIL today (Wave 2 of meta-harness plan
 * add-an-opt-in-paid-residential-proxy-fallback-fo). recordProxySurcharge
 * does not exist yet; Wave 4 lands it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

// Wave 4 will export this from ../src/middleware/sponsor.js; importing it now
// is the failing-test signal (symbol undefined / module export missing).
import {
  recordProxySurcharge,
  readProxySurchargeTodayUsd,
  getProxyConsent,
  putProxyConsent,
  type ProxySurchargeArgs,
} from "../src/middleware/sponsor.js";

const AGENT_ID = "agent_proxy_test_001";
const SKILL_ID = "skill-paid-x402";
const ENDPOINT_ID = "ep-1";

function makeEnv(): Env {
  return {
    API_KEY: "test-api-key",
    STATS_KV: new LocalKV("stats") as unknown as KVNamespace,
    ENVIRONMENT: "local-dev",
    SPONSOR_PROXY_SURCHARGE_USD: "0.01",
  } as Env;
}

beforeEach(() => {
  clearKVCacheForTests();
});

describe("recordProxySurcharge — Wave 4 surface (currently failing)", () => {
  it("writes a sponsor ledger row with surcharge_reason=proxy_429_fallback", async () => {
    const env = makeEnv();
    const ledgerId = "ledger_p_001";
    const args: ProxySurchargeArgs = {
      agent_id: AGENT_ID,
      skill_id: SKILL_ID,
      endpoint_id: ENDPOINT_ID,
      ledger_id: ledgerId,
      cost_usd: 0.01,
    };
    await recordProxySurcharge(env, args);
    const raw = await env.STATS_KV.get(`sponsor:ledger:${ledgerId}`);
    expect(raw).not.toBeNull();
    const row = JSON.parse(raw!);
    expect(row.kind).toBe("sponsor");
    expect(row.surcharge_reason).toBe("proxy_429_fallback");
    expect(row.amount_uc).toBe(10000); // 1¢ in µ¢
    expect(row.payment_method).toBe("surcharge");
    expect(row.agent_id).toBe(AGENT_ID);
    expect(row.endpoint_id).toBe(ENDPOINT_ID);
  });

  it("increments sponsor:proxy-surcharge:<agent>:<today> across N calls", async () => {
    const env = makeEnv();
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) {
      await recordProxySurcharge(env, {
        agent_id: AGENT_ID,
        skill_id: SKILL_ID,
        endpoint_id: ENDPOINT_ID,
        ledger_id: `ledger_p_${i}`,
        cost_usd: 0.01,
      });
    }
    const raw = await env.STATS_KV.get(`sponsor:proxy-surcharge:${AGENT_ID}:${today}`);
    expect(Number(raw)).toBe(30000); // 3 × 10000 µ¢
    const usd = await readProxySurchargeTodayUsd(env, AGENT_ID);
    expect(usd).toBeCloseTo(0.03, 4);
  });

  it("is idempotent on ledger_id (re-call writes once, counter increments once)", async () => {
    const env = makeEnv();
    const args = {
      agent_id: AGENT_ID,
      skill_id: SKILL_ID,
      endpoint_id: ENDPOINT_ID,
      ledger_id: "ledger_dupe_xyz",
      cost_usd: 0.01,
    };
    await recordProxySurcharge(env, args);
    await recordProxySurcharge(env, args);
    const usd = await readProxySurchargeTodayUsd(env, AGENT_ID);
    expect(usd).toBeCloseTo(0.01, 4); // not 0.02
  });

  it("does NOT touch sponsor:agent:<id>:<today> (base cap math untouched)", async () => {
    const env = makeEnv();
    const today = new Date().toISOString().slice(0, 10);
    await recordProxySurcharge(env, {
      agent_id: AGENT_ID,
      skill_id: SKILL_ID,
      endpoint_id: ENDPOINT_ID,
      ledger_id: "ledger_iso_1",
      cost_usd: 0.01,
    });
    const baseRaw = await env.STATS_KV.get(`sponsor:agent:${AGENT_ID}:${today}`);
    expect(baseRaw).toBeNull(); // base counter untouched
  });
});

describe("proxy-consent surface — Wave 4 (currently failing)", () => {
  it("getProxyConsent defaults to 'no' when never set", async () => {
    const env = makeEnv();
    expect(await getProxyConsent(env, AGENT_ID)).toBe("no");
  });

  it("putProxyConsent persists 'yes' and getProxyConsent reads it back", async () => {
    const env = makeEnv();
    await putProxyConsent(env, AGENT_ID, "yes");
    expect(await getProxyConsent(env, AGENT_ID)).toBe("yes");
  });
});
