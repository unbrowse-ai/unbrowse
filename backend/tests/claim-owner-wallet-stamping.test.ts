/**
 * Owner-wallet stamping hook — Step 4 luminary for the cherry-picked
 * `stampOwnerOnDomainSkills` helper.
 *
 * The hook bridges the verified DNS claim (a row in
 * `domain-wallet:<domain>` KV) and the on-chain split (the
 * `OWNER_BPS` lane in `computeFlexSplits`). Without it the lane stays
 * dormant even after a successful claim, because
 * `computeFlexSplits` reads `owner_wallet_usdc_ata` off the skill
 * record and no other path stamps that field on existing skills.
 *
 * No mocks: real `stampOwnerOnDomainSkills` against the same
 * EmergentDB-shaped fetch intercept the existing claim test suite
 * uses (see `claim-routes-skeleton.test.ts` for the pattern).
 *
 * Mutation-tested: flipping the stamped fields to wrong values
 * causes the assertions to fail (Luke 15:4).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stampOwnerOnDomainSkills } from "../src/services/domain-claim-effects.js";
import { clearKVCacheForTests, skillsKV } from "../src/services/kv.js";
import type { Env, SkillManifest } from "../src/types.js";

const baseEnv: Env = {
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

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/qdkv/list") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string };
        const prefix = body.prefix ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return Response.json({ keys: keys.map((name) => ({ name })) });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

beforeEach(() => {
  kvStore = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(kvStore);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

function makeSkill(id: string, overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: id,
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    name: "example.com",
    intent_signature: "test",
    domain: "example.com",
    description: "test",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "ep1",
        method: "GET",
        url_template: "https://example.com/api",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
    ...overrides,
  };
}

async function putSkill(skill: SkillManifest): Promise<void> {
  // Use the production KV layer so the listWithValues index is
  // maintained. Writing through /qdkv/set directly would skip the
  // index update and listSkills would return an empty array — see
  // kv.ts:_idxLoad.
  await skillsKV(baseEnv).put(`skill:${skill.skill_id}`, JSON.stringify(skill));
}

const WALLET = "Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1";
const VERIFIED_AT = "2026-05-18T12:00:00.000Z";
describe("stampOwnerOnDomainSkills", () => {
  it("golden path: stamps every published skill for the domain", async () => {
    await putSkill(makeSkill("s1"));
    await putSkill(makeSkill("s2"));
    await putSkill(makeSkill("s3", { domain: "other.com" }));

    const result = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    expect(result.stamped_count).toBe(2);
    expect(result.skill_ids.sort()).toEqual(["s1", "s2"]);
    for (const id of ["s1", "s2"]) {
      const stored = JSON.parse(kvStore.get(`staging-skills-v3:skill:${id}`)!) as SkillManifest;
      expect(stored.owner_compensation_opt_in).toBe(true);
      expect(stored.owner_wallet_address).toBe(WALLET);
      expect(stored.owner_wallet_usdc_ata).toBe(WALLET);
      expect(stored.owner_wallet_verified_at).toBe(VERIFIED_AT);
    }
    const other = JSON.parse(kvStore.get("staging-skills-v3:skill:s3")!) as SkillManifest;
    expect(other.owner_compensation_opt_in).toBeUndefined();
  });

  it("case-insensitive domain match", async () => {
    await putSkill(makeSkill("s1"));
    const result = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "EXAMPLE.COM",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    expect(result.stamped_count).toBe(1);
    expect(result.domain).toBe("example.com");
  });

  it("skips lifecycle:disabled skills", async () => {
    await putSkill(makeSkill("s1"));
    await putSkill(makeSkill("s2", { lifecycle: "disabled" }));
    const result = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    expect(result.stamped_count).toBe(1);
    expect(result.skill_ids).toEqual(["s1"]);
    const disabled = JSON.parse(kvStore.get("staging-skills-v3:skill:s2")!) as SkillManifest;
    expect(disabled.owner_compensation_opt_in).toBeUndefined();
  });

  it("idempotent on re-call with same wallet", async () => {
    await putSkill(makeSkill("s1"));
    const first = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    expect(first.stamped_count).toBe(1);
    const second = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    expect(second.stamped_count).toBe(0);
  });

  it("overwrite on re-verify with a different wallet", async () => {
    await putSkill(makeSkill("s1"));
    await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    const NEW_WALLET = "CcC222222222222222222222222222222222222222";
    const NEW_TS = "2026-05-19T00:00:00.000Z";
    const result = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: NEW_WALLET,
      verified_at: NEW_TS,
    });
    expect(result.stamped_count).toBe(1);
    const stored = JSON.parse(kvStore.get("staging-skills-v3:skill:s1")!) as SkillManifest;
    expect(stored.owner_wallet_address).toBe(NEW_WALLET);
    expect(stored.owner_wallet_verified_at).toBe(NEW_TS);
  });

  it("no matching skills returns stamped_count:0 cleanly", async () => {
    await putSkill(makeSkill("s1", { domain: "other.com" }));
    const result = await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      verified_at: VERIFIED_AT,
    });
    expect(result.stamped_count).toBe(0);
    expect(result.skill_ids).toEqual([]);
  });

  it("custom wallet_usdc_ata is used when provided", async () => {
    await putSkill(makeSkill("s1"));
    const ATA = "AtA111111111111111111111111111111111111111";
    await stampOwnerOnDomainSkills(baseEnv, {
      domain: "example.com",
      wallet_address: WALLET,
      wallet_usdc_ata: ATA,
      verified_at: VERIFIED_AT,
    });
    const stored = JSON.parse(kvStore.get("staging-skills-v3:skill:s1")!) as SkillManifest;
    expect(stored.owner_wallet_address).toBe(WALLET);
    expect(stored.owner_wallet_usdc_ata).toBe(ATA);
  });
});
