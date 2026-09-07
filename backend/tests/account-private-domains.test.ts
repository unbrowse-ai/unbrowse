/**
 * No-mock test for GET /v1/account/private-domains.
 *
 * Drives the real Hono app + the real EdbKV through a fake fetch (no
 * unit-under-test mock). Two distinct agents seed claim + takedown
 * records via the real `statsKV().put()` adapter — that path drives the
 * actual `_idxUpsert` so the route's `listWithValues()` call returns
 * the same records the production path would see.
 *
 * Verifies the route surface contract:
 *   - returns only the calling agent's records (cross-agent isolation)
 *   - includes both takedowns and claims
 *   - sorts deterministically
 *   - rejects unauthenticated requests
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests, statsKV } from "../src/services/kv.js";
import {
  buildBindingKey,
  buildOptOutKey,
  type DomainClaimBinding,
  type DomainTakedownRecord,
} from "../src/services/domain-claim.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

// Staging auth helper: verifyKey() returns `staging_${token.slice(0, 8)}` for
// any bearer token, so we can craft two distinct agent_ids by choosing tokens
// whose first 8 chars differ. The records we seed must use the SAME formula
// so the route's `verified_by_agent_id` filter matches.
const TOKEN_A = "agent-aaaaXXX"; // -> agent_id "staging_agent-aa"
const TOKEN_B = "agent-bbbbXXX"; // -> agent_id "staging_agent-bb"
const AGENT_A = `staging_${TOKEN_A.slice(0, 8)}`;
const AGENT_B = `staging_${TOKEN_B.slice(0, 8)}`;

function makeKvHarness(): { kv: Map<string, string>; fetchImpl: typeof fetch } {
  const kv = new Map<string, string>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        kv.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = kv.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        kv.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  return { kv, fetchImpl };
}

function takedownRecord(domain: string, agentId: string, reason?: string): DomainTakedownRecord {
  return {
    domain,
    verified_at: "2026-05-18T10:00:00.000Z",
    verified_by_agent_id: agentId,
    txt_value_witness: `unbrowse-takedown=stub-${domain}`,
    doh_attestations: [
      { provider: "cloudflare", observed_at: "2026-05-18T10:00:00.000Z" },
      { provider: "google", observed_at: "2026-05-18T10:00:00.001Z" },
    ],
    reason,
    schema_version: 1,
  };
}

function claimRecord(domain: string, agentId: string, wallet: string): DomainClaimBinding {
  return {
    domain,
    wallet_address: wallet,
    verified_at: "2026-05-18T11:00:00.000Z",
    verified_by_agent_id: agentId,
    txt_value_witness: `unbrowse-claim=stub-${domain};wallet=${wallet}`,
    doh_attestations: [
      { provider: "cloudflare", observed_at: "2026-05-18T11:00:00.000Z" },
      { provider: "google", observed_at: "2026-05-18T11:00:00.001Z" },
    ],
    schema_version: 1,
  };
}

async function getJson(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.fetch(new Request(`http://local.test${path}`, { method: "GET", headers }), env);
}

let originalFetch: typeof fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  const h = makeKvHarness();
  globalThis.fetch = h.fetchImpl;
  clearKVCacheForTests();

  // Seed: two takedowns for agent A, one takedown for agent B, one claim for
  // agent A. Use the REAL statsKV().put() so the index is populated the same
  // way the production claim/takedown verify routes do it.
  const kv = statsKV(env);
  await kv.put(buildOptOutKey("zeta-alpha.com"), JSON.stringify(takedownRecord("zeta-alpha.com", AGENT_A, "internal dashboard")));
  await kv.put(buildOptOutKey("agent-a-two.com"), JSON.stringify(takedownRecord("agent-a-two.com", AGENT_A)));
  await kv.put(buildOptOutKey("agent-b-only.com"), JSON.stringify(takedownRecord("agent-b-only.com", AGENT_B)));
  await kv.put(buildBindingKey("agent-a-claim.com"), JSON.stringify(claimRecord("agent-a-claim.com", AGENT_A, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("GET /v1/account/private-domains", () => {
  it("returns only the calling agent's takedowns + claims, sorted by domain", async () => {
    const res = await getJson("/v1/account/private-domains", TOKEN_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      takedowns: Array<{ domain: string; opted_out_at: string; reason?: string }>;
      claims: Array<{ domain: string; wallet_address: string; verified_at: string }>;
      agent_id: string;
    };
    expect(body.agent_id).toBe(AGENT_A);
    expect(body.takedowns.map((t) => t.domain)).toEqual(["agent-a-two.com", "zeta-alpha.com"]);
    expect(body.takedowns[1].reason).toBe("internal dashboard");
    expect(body.takedowns[0].reason).toBeUndefined();
    expect(body.takedowns.every((t) => typeof t.opted_out_at === "string" && t.opted_out_at.length > 0)).toBe(true);
    expect(body.claims.map((c) => c.domain)).toEqual(["agent-a-claim.com"]);
    expect(body.claims[0].wallet_address).toBe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  });

  it("a different agent sees only its own records — never another agent's", async () => {
    const res = await getJson("/v1/account/private-domains", TOKEN_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      takedowns: Array<{ domain: string }>;
      claims: Array<{ domain: string }>;
      agent_id: string;
    };
    expect(body.agent_id).toBe(AGENT_B);
    expect(body.takedowns.map((t) => t.domain)).toEqual(["agent-b-only.com"]);
    expect(body.claims).toEqual([]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await getJson("/v1/account/private-domains");
    expect(res.status).toBe(401);
  });

  it("returns empty arrays for an agent with zero records", async () => {
    const res = await getJson("/v1/account/private-domains", "agent-empty-X");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      takedowns: unknown[];
      claims: unknown[];
      agent_id: string;
    };
    expect(body.agent_id).toBe("staging_agent-em");
    expect(body.takedowns).toEqual([]);
    expect(body.claims).toEqual([]);
  });
});
