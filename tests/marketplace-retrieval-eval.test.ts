import { describe, expect, it } from "bun:test";

import {
  domainMatchesRequested,
  evaluateRetrievalCase,
  hasExpectedResult,
  parseSearchResultMetadata,
  selectReadinessCases,
} from "../scripts/eval-marketplace-retrieval.ts";

const FIXTURE_CORPUS = {
  fixtures: [
    {
      id: "alpha-docs",
      skill_id: "marketplace-eval-alpha-docs",
      domain: "docs.alpha-eval.com",
      version: "1.0.0",
      schema_version: "1",
      name: "docs.alpha-eval.com",
      intent_signature: "docs.alpha-eval.com",
      description: "fixture",
      owner_type: "agent",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-21T00:00:00Z",
      updated_at: "2026-03-21T00:00:00Z",
      endpoints: [],
    },
    {
      id: "alpha-packages",
      skill_id: "marketplace-eval-alpha-packages",
      domain: "packages.alpha-eval.com",
      version: "1.0.0",
      schema_version: "1",
      name: "packages.alpha-eval.com",
      intent_signature: "packages.alpha-eval.com",
      description: "fixture",
      owner_type: "agent",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-21T00:00:00Z",
      updated_at: "2026-03-21T00:00:00Z",
      endpoints: [],
    },
  ],
  cases: [],
};

function result(skill_id: string, endpoint_id: string, domain: string, score = 0.9) {
  return {
    id: Math.floor(score * 1000),
    score,
    metadata: {
      content: JSON.stringify({ skill_id, endpoint_id, domain }),
    },
  };
}

describe("marketplace retrieval eval helpers", () => {
  it("parses search metadata from encoded content", () => {
    expect(parseSearchResultMetadata(result(
      "marketplace-eval-alpha-docs",
      "alpha-doc-search",
      "docs.alpha-eval.com",
    ))).toEqual({
      skill_id: "marketplace-eval-alpha-docs",
      endpoint_id: "alpha-doc-search",
      domain: "docs.alpha-eval.com",
    });
  });

  it("matches domains by exact or registrable family", () => {
    expect(domainMatchesRequested("docs.alpha-eval.com", "docs.alpha-eval.com", "exact")).toBe(true);
    expect(domainMatchesRequested("packages.alpha-eval.com", "docs.alpha-eval.com", "exact")).toBe(false);
    expect(domainMatchesRequested("packages.alpha-eval.com", "docs.alpha-eval.com", "registrable")).toBe(true);
  });

  it("passes when rank and domain filter are both clean", () => {
    const evaluation = evaluateRetrievalCase(
      FIXTURE_CORPUS as any,
      {
        id: "domain-alpha-docs",
        route: "domain",
        lane: "results",
        intent: "search docs",
        domain: "docs.alpha-eval.com",
        expect: {
          fixture: "alpha-docs",
          endpoint_id: "alpha-doc-search",
          max_rank: 1,
          domain_match: "exact",
          max_offdomain_results: 0,
        },
      },
      {
        results: [
          result("marketplace-eval-alpha-docs", "alpha-doc-search", "docs.alpha-eval.com"),
          result("marketplace-eval-alpha-docs", "alpha-release-notes", "docs.alpha-eval.com", 0.8),
        ],
      },
    );

    expect(evaluation.ok).toBe(true);
    expect(evaluation.expected_rank).toBe(1);
    expect(evaluation.offdomain_results).toBe(0);
  });

  it("fails when the lane leaks an off-domain result", () => {
    const evaluation = evaluateRetrievalCase(
      FIXTURE_CORPUS as any,
      {
        id: "domain-alpha-docs",
        route: "domain",
        lane: "results",
        intent: "search docs",
        domain: "docs.alpha-eval.com",
        expect: {
          fixture: "alpha-docs",
          endpoint_id: "alpha-doc-search",
          max_rank: 1,
          domain_match: "exact",
          max_offdomain_results: 0,
        },
      },
      {
        results: [
          result("marketplace-eval-alpha-docs", "alpha-doc-search", "docs.alpha-eval.com"),
          result("marketplace-eval-alpha-packages", "alpha-package-info", "packages.alpha-eval.com", 0.7),
        ],
      },
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("domain_filter_leakage");
  });

  it("fails when resolve unexpectedly skips global fallback", () => {
    const evaluation = evaluateRetrievalCase(
      FIXTURE_CORPUS as any,
      {
        id: "resolve-alpha-sibling-fallback",
        route: "resolve",
        lane: "global_results",
        intent: "package info",
        domain: "docs.alpha-eval.com",
        expect: {
          fixture: "alpha-packages",
          endpoint_id: "alpha-package-info",
          max_rank: 3,
          skipped_global: false,
        },
      },
      {
        domain_results: [],
        global_results: [result("marketplace-eval-alpha-packages", "alpha-package-info", "packages.alpha-eval.com")],
        skipped_global: true,
      },
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("unexpected_skipped_global");
  });

  it("fails clearly when search results omit metadata", () => {
    const evaluation = evaluateRetrievalCase(
      FIXTURE_CORPUS as any,
      {
        id: "global-alpha-docs",
        route: "search",
        lane: "results",
        intent: "search docs",
        expect: {
          fixture: "alpha-docs",
          endpoint_id: "alpha-doc-search",
          max_rank: 1,
        },
      },
      {
        results: [{ id: 1, score: 0.8 }, { id: 2, score: 0.7 }],
      },
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.metadata_available).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("missing_result_metadata");
  });

  it("readiness requires the expected fixture in the target lane", () => {
    const testCase = {
      id: "resolve-alpha-sibling-fallback",
      route: "resolve" as const,
      lane: "global_results" as const,
      intent: "package info",
      domain: "docs.alpha-eval.com",
      expect: {
        fixture: "alpha-packages",
        endpoint_id: "alpha-package-info",
        max_rank: 3,
        skipped_global: false,
      },
    };

    expect(hasExpectedResult(FIXTURE_CORPUS as any, testCase, {
      domain_results: [result("marketplace-eval-alpha-docs", "alpha-doc-search", "docs.alpha-eval.com")],
      global_results: [result("marketplace-eval-alpha-packages", "alpha-package-info", "packages.alpha-eval.com")],
      skipped_global: false,
    })).toBe(true);

    expect(hasExpectedResult(FIXTURE_CORPUS as any, testCase, {
      domain_results: [result("marketplace-eval-alpha-docs", "alpha-doc-search", "docs.alpha-eval.com")],
      global_results: [result("marketplace-eval-alpha-docs", "alpha-release-notes", "docs.alpha-eval.com")],
      skipped_global: false,
    })).toBe(false);
  });

  it("samples one readiness probe per fixture and prefers search when present", () => {
    const cases = selectReadinessCases({
      ...FIXTURE_CORPUS,
      cases: [
        {
          id: "resolve-alpha-docs",
          route: "resolve",
          lane: "domain_results",
          intent: "search docs",
          domain: "docs.alpha-eval.com",
          expect: {
            fixture: "alpha-docs",
            endpoint_id: "alpha-doc-search",
          },
        },
        {
          id: "search-alpha-docs",
          route: "search",
          lane: "results",
          intent: "search docs",
          expect: {
            fixture: "alpha-docs",
            endpoint_id: "alpha-doc-search",
          },
        },
        {
          id: "domain-alpha-packages",
          route: "domain",
          lane: "results",
          intent: "package info",
          domain: "packages.alpha-eval.com",
          expect: {
            fixture: "alpha-packages",
            endpoint_id: "alpha-package-info",
          },
        },
      ],
    } as any);

    expect(cases.map((testCase) => testCase.id)).toEqual([
      "search-alpha-docs",
      "domain-alpha-packages",
    ]);
  });
});
