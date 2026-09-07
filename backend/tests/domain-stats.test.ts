/**
 * domain-stats.test — the witness for per-domain observability: every domain
 * being indexed (skills/endpoints), used (executions), and queried for
 * (hits/misses, including unindexed demand) appears in the merged stats
 * surface — and the surface is aggregate-only (no agent id, wallet, or intent
 * text anywhere in the payload).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publicStatsRoutes } from "../src/routes/stats.js";
import { recordDomainQuery, getDomainStats } from "../src/services/domain-stats.js";
import { clearKVCacheForTests, skillsKV, statsKV } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
};

function skillFixture(skill_id: string, domain: string, lifecycle = "active") {
  return {
    skill_id,
    domain,
    lifecycle,
    endpoints: [
      { endpoint_id: `${skill_id}-ep-a`, method: "GET", url_template: `https://${domain}/a` },
      { endpoint_id: `${skill_id}-ep-b`, method: "GET", url_template: `https://${domain}/b` },
    ],
  };
}

describe("domain-stats", () => {
  beforeEach(async () => {
    clearKVCacheForTests();
    const skills = skillsKV(BASE_ENV);
    await skills.put("skill:alpha", JSON.stringify(skillFixture("alpha", "alpha.example.com")));
    await skills.put("skill:beta", JSON.stringify(skillFixture("beta", "beta.example.com")));
    await skills.put("skill:old", JSON.stringify(skillFixture("old", "old.example.com", "deprecated")));

    const stats = statsKV(BASE_ENV);
    await stats.put("stats:alpha--alpha-ep-a", JSON.stringify({ total_executions: 12, successful_executions: 11 }));
    await stats.put("stats:alpha--alpha-ep-b", JSON.stringify({ total_executions: 3, successful_executions: 3 }));
    await stats.put("stats:beta--beta-ep-a", JSON.stringify({ total_executions: 5, successful_executions: 4 }));
  });

  afterEach(() => {
    clearKVCacheForTests();
  });

  it("merges indexed + used + queried into one per-domain view", async () => {
    // queried: one indexed domain (hit), one unindexed domain (miss ×2 = demand gap)
    await recordDomainQuery(BASE_ENV, "alpha.example.com", true);
    await recordDomainQuery(BASE_ENV, "wanted.example.com", false);
    await recordDomainQuery(BASE_ENV, "https://Wanted.example.com/some/path", false); // normalized

    const out = await getDomainStats(BASE_ENV);
    const byDomain = new Map(out.domains.map((d) => [d.domain, d]));

    const alpha = byDomain.get("alpha.example.com")!;
    expect(alpha.indexed).toBe(true);
    expect(alpha.skills).toBe(1);
    expect(alpha.endpoints).toBe(2);
    expect(alpha.executions).toBe(15);
    expect(alpha.successful_executions).toBe(14);
    expect(alpha.queries).toBe(1);
    expect(alpha.misses).toBe(0);
    expect(alpha.last_queried_at).toBeTruthy();

    // used but never queried
    const beta = byDomain.get("beta.example.com")!;
    expect(beta.indexed).toBe(true);
    expect(beta.executions).toBe(5);
    expect(beta.queries).toBe(0);

    // queried but not indexed — the demand gap, first-class
    const wanted = byDomain.get("wanted.example.com")!;
    expect(wanted.indexed).toBe(false);
    expect(wanted.queries).toBe(2);
    expect(wanted.misses).toBe(2);

    // deprecated skills don't count as indexed
    expect(byDomain.has("old.example.com")).toBe(false);

    expect(out.totals.domains_indexed).toBe(2);
    expect(out.totals.domains_queried).toBe(2);
    expect(out.totals.domains_used).toBe(2);
    expect(out.totals.domains_queried_not_indexed).toBe(1);
    expect(out.totals.queries).toBe(3);
    expect(out.totals.query_misses).toBe(2);
    expect(out.totals.executions).toBe(20);
  });

  it("GET /v1/stats/domains serves the merged view, aggregate-only", async () => {
    await recordDomainQuery(BASE_ENV, "alpha.example.com", true);
    await recordDomainQuery(BASE_ENV, "wanted.example.com", false);

    const res = await publicStatsRoutes.request("http://localhost/stats/domains", {}, BASE_ENV);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Awaited<ReturnType<typeof getDomainStats>>;

    expect(body.totals.domains_queried_not_indexed).toBe(1);
    expect(body.domains.some((d) => d.domain === "wanted.example.com" && !d.indexed)).toBe(true);

    // PRIVACY: nothing caller-identifying in the payload — the schema has no
    // slot for it, and the serialized body carries none of the known shapes.
    expect(raw).not.toMatch(/agent[_-]?id/i);
    expect(raw).not.toMatch(/wallet/i);
    expect(raw).not.toMatch(/intent/i);
  });

  it("recordDomainQuery drops malformed domains instead of polluting the surface", async () => {
    await recordDomainQuery(BASE_ENV, "not a domain!!", true);
    await recordDomainQuery(BASE_ENV, "", true);
    const out = await getDomainStats(BASE_ENV);
    expect(out.domains.every((d) => /^[a-z0-9.-]+$/.test(d.domain))).toBe(true);
    expect(out.totals.queries).toBe(0);
  });
});
