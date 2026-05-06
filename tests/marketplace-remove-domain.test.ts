import { afterEach, expect, test } from "bun:test";
import { getSkillByDomain, listSkillCards, removeDomainFromMarketplace } from "../backend/src/services/marketplace";
import { skillsKV } from "../backend/src/services/kv";
import type { Env, SkillManifest } from "../backend/src/types";

const originalFetch = globalThis.fetch;

function env(): Env {
  return {
    ENVIRONMENT: "local-dev",
    STATS_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env;
}

function skill(domain: string): SkillManifest {
  return {
    skill_id: `skill-${domain}`,
    schema_version: "1",
    version: "1.0.0",
    name: domain,
    description: "Test skill",
    domain,
    intent_signature: domain,
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    endpoints: [
      {
        endpoint_id: "read",
        method: "GET",
        url_template: `https://${domain}/api/read`,
        verification_status: "verified",
        reliability_score: 1,
        description: "Read records",
      },
    ],
    created_at: "2026-05-06T00:00:00.000Z",
    updated_at: "2026-05-06T00:00:00.000Z",
  } as SkillManifest;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("removeDomainFromMarketplace hides skills and domain aliases", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  const testEnv = env();
  const kv = skillsKV(testEnv);
  const target = "private.example.com";
  const manifest = skill(target);

  await kv.put(`skill:${manifest.skill_id}`, JSON.stringify(manifest));
  await kv.put(`domain-idx:${target}`, manifest.skill_id);
  await kv.put(`intent-idx:${target}:abc`, manifest.skill_id);
  const suppressed = skill("pearlpediatric.curvehero.com");
  await kv.put(`skill:${suppressed.skill_id}`, JSON.stringify(suppressed));

  expect((await listSkillCards(testEnv)).map((entry) => entry.domain)).toContain(target);
  expect((await listSkillCards(testEnv)).map((entry) => entry.domain)).not.toContain(suppressed.domain);
  expect(await getSkillByDomain(testEnv, suppressed.domain)).toBeNull();
  expect((await getSkillByDomain(testEnv, target))?.skill_id).toBe(manifest.skill_id);

  const result = await removeDomainFromMarketplace(testEnv, target);

  expect(result.disabled_skill_ids).toEqual([manifest.skill_id]);
  expect(await kv.get(`domain-idx:${target}`)).toBeNull();
  expect(await kv.get(`intent-idx:${target}:abc`)).toBeNull();
  expect((await getSkillByDomain(testEnv, target))).toBeNull();
  expect((await listSkillCards(testEnv)).map((entry) => entry.domain)).not.toContain(target);
});
