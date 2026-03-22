import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Corpus = {
  fixtures?: Array<{
    id: string;
    skill_id: string;
    domain: string;
    endpoints: Array<{ endpoint_id: string }>;
  }>;
  cases?: Array<{
    id: string;
    route: "search" | "domain" | "resolve";
    lane?: "results" | "domain_results" | "global_results";
    intent: string;
    domain?: string;
    expect: {
      fixture: string;
      endpoint_id: string;
      max_rank?: number;
      domain_match?: "exact" | "registrable";
      max_offdomain_results?: number;
      skipped_global?: boolean;
    };
  }>;
};

describe("marketplace retrieval corpus", () => {
  it("stays broad enough to catch rank, fallback, and domain-filter regressions", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "marketplace-retrieval-cases.json"), "utf-8"),
    ) as Corpus;

    const fixtures = raw.fixtures ?? [];
    const cases = raw.cases ?? [];

    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    expect(cases.length).toBeGreaterThanOrEqual(12);

    const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
    const fixtureSkillIds = new Set(fixtures.map((fixture) => fixture.skill_id));
    const endpointsByFixture = new Map(fixtures.map((fixture) => [
      fixture.id,
      new Set(fixture.endpoints.map((endpoint) => endpoint.endpoint_id)),
    ]));

    const routes = new Set<string>();
    const exactDomainCases = new Set<string>();
    const fallbackCases = new Set<string>();

    for (const testCase of cases) {
      expect(testCase.id.length).toBeGreaterThan(0);
      expect(testCase.intent.length).toBeGreaterThan(0);
      expect(fixtureIds.has(testCase.expect.fixture)).toBe(true);
      expect(endpointsByFixture.get(testCase.expect.fixture)?.has(testCase.expect.endpoint_id)).toBe(true);

      routes.add(testCase.route);
      if (testCase.expect.domain_match === "exact") {
        expect(typeof testCase.domain).toBe("string");
        exactDomainCases.add(testCase.id);
      }
      if (typeof testCase.expect.skipped_global === "boolean") {
        expect(testCase.route).toBe("resolve");
        expect(testCase.lane).toBe("global_results");
        fallbackCases.add(testCase.id);
      }
    }

    expect(routes).toEqual(new Set(["search", "domain", "resolve"]));
    expect(exactDomainCases.size).toBeGreaterThanOrEqual(5);
    expect(fallbackCases.size).toBeGreaterThanOrEqual(3);
    expect(fixtureSkillIds.has("marketplace-eval-alpha-docs")).toBe(true);
    expect(fixtureSkillIds.has("marketplace-eval-alpha-packages")).toBe(true);
    expect(fixtureSkillIds.has("marketplace-eval-beta-community")).toBe(true);
    expect(fixtureSkillIds.has("marketplace-eval-gamma-market")).toBe(true);
    expect(fixtureSkillIds.has("marketplace-eval-gamma-news")).toBe(true);
  });
});
