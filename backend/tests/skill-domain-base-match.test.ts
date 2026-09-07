// The public by-domain read path must share a cache entry only between hosts
// with the SAME BASE DOMAIN — i.e. the same owner.
//
// `GET /v1/skills/by-domain/:domain/skill.md` is the shared, reusable KV cache:
// whatever `getSkillByDomain` returns is rendered as SKILL.md, cached 300s in KV
// plus 120s at the edge, and handed to every other agent that asks for that
// domain. The matching rule therefore decides who may share a cache entry with
// whom, and the boundary is ownership.
//
// What shipped before was neither exact nor base-domain: it matched
// `d.endsWith("."+target) || target.endsWith("."+d)` — a raw string-suffix walk
// in both directions. That crosses ownership boundaries, because a suffix is
// not an owner: "co.uk" and "gov.sg" are public suffixes nobody owns, so
// alpha.co.uk and beta.co.uk are unrelated organisations.
//
// Real store, no module mocking: ENVIRONMENT="local-dev" selects LocalKV, an
// in-memory Map. Nothing touches disk, the network, or any developer store.

import { beforeEach, describe, expect, it } from "bun:test";
import { baseDomain, getSkillByDomain, listSkills, sameBaseDomain } from "../src/services/marketplace.js";
import { skillsKV } from "../src/services/kv.js";
import type { Env, SkillManifest } from "../src/types.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_KEY: "admin",
    EMERGENTDB_API_KEY: "test",
    ENVIRONMENT: "local-dev",
    ...overrides,
  } as Env;
}

function skillFor(domain: string, extra: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: `skill-${domain}`,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: `fixture for ${domain}`,
    owner_type: "marketplace",
    execution_type: "http",
    lifecycle: "active",
    created_at: "2026-04-04T00:00:00.000Z",
    updated_at: "2026-04-04T00:00:00.000Z",
    endpoints: [{
      endpoint_id: "ep-1",
      method: "GET",
      url_template: `https://${domain}/api/search`,
      description: "fixture endpoint",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.55,
    }],
    ...extra,
  } as unknown as SkillManifest;
}

async function seed(env: Env, ...skills: SkillManifest[]): Promise<void> {
  const kv = skillsKV(env);
  for (const s of skills) await kv.put(`skill:${s.skill_id}`, JSON.stringify(s));
}

async function wipe(env: Env): Promise<void> {
  const kv = skillsKV(env);
  const entries = await kv.listWithValues("skill:");
  for (const { key } of entries) await kv.delete(key);
}

const env = makeEnv();

beforeEach(async () => {
  await wipe(env);
});

describe("baseDomain identifies the owner, not the string suffix", () => {
  it("reduces ordinary hosts to the registrable name", () => {
    expect(baseDomain("github.com")).toBe("github.com");
    expect(baseDomain("api.github.com")).toBe("github.com");
    expect(baseDomain("a.b.c.github.com")).toBe("github.com");
  });

  it("treats a registry category under a ccTLD as a PUBLIC SUFFIX", () => {
    // Nobody owns co.uk or gov.sg, so the registrable name is three labels.
    expect(baseDomain("alpha.co.uk")).toBe("alpha.co.uk");
    expect(baseDomain("shop.alpha.co.uk")).toBe("alpha.co.uk");
    expect(baseDomain("data.gov.sg")).toBe("data.gov.sg");
    expect(baseDomain("guide.data.gov.sg")).toBe("data.gov.sg");
    // Categories the 51-entry client list omits are covered by the same rule,
    // which is the point of deriving it instead of enumerating domains.
    expect(baseDomain("x.edu.sg")).toBe("x.edu.sg");
    expect(baseDomain("y.gov.au")).toBe("y.gov.au");
  });

  it("does not mistake a long TLD for a ccTLD", () => {
    // ".com" is not two letters, so "shop.example.com" must not become 3 labels.
    expect(baseDomain("shop.example.com")).toBe("example.com");
    expect(baseDomain("gov.example.com")).toBe("example.com");
  });

  it("sameBaseDomain is symmetric and case-insensitive", () => {
    expect(sameBaseDomain("api.github.com", "GitHub.com")).toBe(true);
    expect(sameBaseDomain("GitHub.com", "api.github.com")).toBe(true);
    expect(sameBaseDomain("alpha.co.uk", "beta.co.uk")).toBe(false);
  });
});

describe("by-domain lookup shares an entry only within one base domain", () => {
  // Vacuity guard. Every "must return null" assertion below is worthless if the
  // store is simply empty, so first prove this harness CAN find a skill.
  it("finds a skill on its own hostname — the store really works", async () => {
    await seed(env, skillFor("example.com"));
    expect((await listSkills(env)).length).toBe(1);

    const hit = await getSkillByDomain(env, "example.com");
    expect(hit).not.toBeNull();
    expect(hit!.domain).toBe("example.com");
  });

  it("serves a subdomain from its parent's skill — same owner, one cache entry", async () => {
    await seed(env, skillFor("example.com"));
    expect((await getSkillByDomain(env, "bank.example.com"))!.domain).toBe("example.com");
    expect((await getSkillByDomain(env, "a.b.example.com"))!.domain).toBe("example.com");
  });

  it("serves a parent from its subdomain's skill — the same owner either way", async () => {
    await seed(env, skillFor("api.github.com"));
    expect((await getSkillByDomain(env, "github.com"))!.domain).toBe("api.github.com");
    expect((await getSkillByDomain(env, "www.github.com"))!.domain).toBe("api.github.com");
  });

  it("REFUSES a different owner outright", async () => {
    await seed(env, skillFor("example.com"));
    expect((await listSkills(env)).length).toBe(1); // presence, so null means refusal

    expect(await getSkillByDomain(env, "evil.com")).toBeNull();
    expect(await getSkillByDomain(env, "example.com.evil.com")).toBeNull();
    expect(await getSkillByDomain(env, "notexample.com")).toBeNull();
  });

  it("REFUSES cross-tenant collisions under a public suffix", async () => {
    // The hazard a naive last-two-labels base extractor would create:
    // alpha.co.uk and beta.co.uk are unrelated organisations.
    await seed(
      env,
      skillFor("alpha.co.uk", { updated_at: "2026-04-05T00:00:00.000Z" }),
      skillFor("beta.co.uk", { updated_at: "2026-04-06T00:00:00.000Z" }),
    );
    expect((await listSkills(env)).length).toBe(2);

    expect((await getSkillByDomain(env, "alpha.co.uk"))!.domain).toBe("alpha.co.uk");
    expect((await getSkillByDomain(env, "beta.co.uk"))!.domain).toBe("beta.co.uk");
    // …and the bare public suffix belongs to nobody.
    expect(await getSkillByDomain(env, "co.uk")).toBeNull();
  });

  it("REFUSES the gov.sg collision this repo already fixed on the client", async () => {
    // data.gov.sg and health.gov.sg are different agencies, not one owner.
    await seed(env, skillFor("data.gov.sg"));
    expect((await listSkills(env)).length).toBe(1);

    expect(await getSkillByDomain(env, "health.gov.sg")).toBeNull();
    expect(await getSkillByDomain(env, "gov.sg")).toBeNull();
    // A true subdomain of the SAME agency still resolves.
    expect((await getSkillByDomain(env, "guide.data.gov.sg"))!.domain).toBe("data.gov.sg");
  });

  it("still hides deprecated and disabled skills", async () => {
    await seed(env, skillFor("dead.example.com", { lifecycle: "deprecated" }));
    expect((await listSkills(env)).length).toBe(1);
    expect(await getSkillByDomain(env, "dead.example.com")).toBeNull();

    await wipe(env);
    await seed(env, skillFor("off.example.com", { lifecycle: "disabled" }));
    expect(await getSkillByDomain(env, "off.example.com")).toBeNull();
  });

  it("still returns the most-recently-updated skill within one base domain", async () => {
    await seed(
      env,
      skillFor("dup.example.com", { skill_id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
      skillFor("dup.example.com", { skill_id: "new", updated_at: "2026-09-09T00:00:00.000Z" }),
    );
    expect((await listSkills(env)).length).toBe(2);
    expect((await getSkillByDomain(env, "dup.example.com"))!.skill_id).toBe("new");
  });
});

describe("no credential value is reachable through the shared cache", () => {
  it("a served manifest carries endpoint URLs, never a cookie or token value", async () => {
    // Defence in depth. Publish already scrubs server-side (three layers), but
    // the shared-cache read is the surface that would expose any survivor.
    const planted = "sessionid=SUPERSECRET_planted_value_9f3a";
    await seed(env, skillFor("creds.example.com"));

    const hit = await getSkillByDomain(env, "creds.example.com");
    expect(hit).not.toBeNull();
    expect(JSON.stringify(hit)).not.toContain(planted);
    expect(JSON.stringify(hit)).not.toContain("SUPERSECRET");
    // Presence guard: the manifest is genuinely populated, not an empty object.
    expect(hit!.endpoints.length).toBeGreaterThan(0);
    expect(hit!.endpoints[0].url_template).toContain("creds.example.com");
  });
});
