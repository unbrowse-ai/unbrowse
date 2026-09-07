import { describe, expect, test } from "bun:test";
import {
  createRestrictionPolicy,
  parseRestrictionEvidence,
  RESTRICT_EVALS,
  RESTRICTION_EVIDENCE_VERSION,
  RestrictionConfigurationError,
  RestrictionDeniedError,
  RestrictionEvidenceError,
  vibeRestrict,
} from "../src/runtime/restrict";

const catalog = ["fetch_price", "read_page", "click"];
const evidence = (
  sampleId: string,
  used: string[],
  attribution: { hallucination?: string[]; over_scrape?: string[] } = {},
  scope = "browser:shop",
) => ({ version: RESTRICTION_EVIDENCE_VERSION, sampleId, scope, used, attribution });

describe("vibe-restrict", () => {
  test("empty evidence yields no denial and never invents authority", () => {
    const result = vibeRestrict([], { knownTools: catalog, scope: "browser:shop" });
    expect(result.deny).toEqual([]);
    expect(result.allow).toEqual([]);
    expect(RESTRICT_EVALS).toBe("bench/sites100/.artifacts/run-*.jsonl");
  });

  test("strict parser rejects legacy heuristics, unsupported versions, and unknown failure classes", () => {
    expect(() => parseRestrictionEvidence({ task: "hallucinated", used: ["fetch_price"] })).toThrow(
      RestrictionEvidenceError,
    );
    expect(() => parseRestrictionEvidence({
      ...evidence("x", ["fetch_price"]),
      version: "restriction-evidence/v2",
    })).toThrow("version is unsupported");
    expect(() => parseRestrictionEvidence({
      ...evidence("x", ["fetch_price"]),
      attribution: { timeout: ["fetch_price"] },
    })).toThrow("not a supported failure class");
    expect(() => parseRestrictionEvidence({
      ...evidence("x", ["fetch_price"]),
      ok: false,
    })).toThrow("is not permitted");
  });

  test("only explicit attribution counts; used tools and unrelated verdicts do not", () => {
    const clean = [
      evidence("1", ["fetch_price"]),
      evidence("2", ["fetch_price"]),
      evidence("3", ["fetch_price"]),
    ];
    const result = vibeRestrict(clean, {
      knownTools: catalog,
      scope: "browser:shop",
      minSamples: 3,
      minAttributedFailures: 2,
      minFailureRate: 0.5,
    });
    expect(result.deny).toEqual([]);
    expect(result.statistics.fetch_price).toEqual({ samples: 3, attributedFailures: 0, failureRate: 0 });
  });

  test("unions explicit attribution classes and counts one failure per sample", () => {
    const result = vibeRestrict([
      evidence("1", ["fetch_price", "read_page"], {
        hallucination: ["fetch_price"],
        over_scrape: ["fetch_price", "read_page"],
      }),
      evidence("2", ["fetch_price", "read_page"], { hallucination: ["fetch_price"] }),
      evidence("3", ["fetch_price", "read_page"]),
    ], {
      knownTools: catalog,
      scope: "browser:shop",
      minSamples: 3,
      minAttributedFailures: 2,
      minFailureRate: 0.5,
    });
    expect(result.statistics.fetch_price).toEqual({ samples: 3, attributedFailures: 2, failureRate: 2 / 3 });
    expect(result.statistics.read_page.attributedFailures).toBe(1);
    expect(result.deny).toEqual(["fetch_price"]);
  });

  test("decisions are scope-local and statistically thresholded", () => {
    const result = vibeRestrict([
      evidence("other-1", ["click"], { hallucination: ["click"] }, "browser:admin"),
      evidence("shop-1", ["click"], { hallucination: ["click"] }),
      evidence("shop-2", ["click"]),
    ], {
      knownTools: catalog,
      scope: "browser:shop",
      minSamples: 2,
      minAttributedFailures: 2,
      minFailureRate: 0.5,
    });
    expect(result.statistics.click).toEqual({ samples: 2, attributedFailures: 1, failureRate: 0.5 });
    expect(result.deny).toEqual([]);
  });

  test("ignores foreign-scope catalogs and duplicate ids before local validation", () => {
    const result = vibeRestrict([
      evidence("same", ["admin_only"], { hallucination: ["admin_only"] }, "browser:admin"),
      evidence("same", ["read_page"], {}, "browser:shop"),
    ], { knownTools: catalog, scope: "browser:shop", minSamples: 1, minAttributedFailures: 1 });
    expect(result.statistics.read_page.samples).toBe(1);
    expect(result.deny).toEqual([]);
  });

  test("catalog validation rejects unknown, unused attribution, duplicate samples, and bad config", () => {
    expect(() => vibeRestrict([evidence("1", ["invented"])], {
      knownTools: catalog,
      scope: "browser:shop",
    })).toThrow("unknown tool");
    expect(() => vibeRestrict([evidence("1", ["read_page"], { hallucination: ["click"] })], {
      knownTools: catalog,
      scope: "browser:shop",
    })).toThrow("was not used");
    expect(() => vibeRestrict([evidence("1", []), evidence("1", [])], {
      knownTools: catalog,
      scope: "browser:shop",
    })).toThrow("duplicate sampleId");
    expect(() => vibeRestrict([], { knownTools: [], scope: "browser:shop" })).toThrow(
      RestrictionConfigurationError,
    );
  });

  test("dispatcher policy narrows authorization and is enforceable", () => {
    const policy = createRestrictionPolicy({ deny: ["click"] }, catalog);
    expect(policy.decide("read_page", true)).toEqual({ allowed: true });
    expect(policy.decide("read_page", false)).toEqual({ allowed: false, reason: "not_authorized" });
    expect(policy.decide("read_page", "yes" as any)).toEqual({ allowed: false, reason: "not_authorized" });
    expect(policy.decide("click", true)).toEqual({ allowed: false, reason: "evidence_restriction" });
    expect(policy.decide("unknown", true)).toEqual({ allowed: false, reason: "unknown_tool" });
    expect(() => policy.assertCanDispatch("click", true)).toThrow(RestrictionDeniedError);
    expect(() => policy.assertCanDispatch("read_page", false)).toThrow(RestrictionDeniedError);
    expect(() => createRestrictionPolicy({ deny: ["invented"] }, catalog)).toThrow(
      RestrictionConfigurationError,
    );
  });
});
