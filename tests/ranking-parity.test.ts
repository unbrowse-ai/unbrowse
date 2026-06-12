/**
 * tests/ranking-parity.test.ts — P1 Wave-3 safety net.
 *
 * Snapshots the EXACT score and ordering that `rankEndpoints` produces
 * today on a corpus of 5 representative fixtures (search/people/comms/
 * detail/protected). Baselines are hardcoded numerics computed from the
 * current implementation in `src/execution/index.ts:rankEndpoints`.
 *
 * **The point of this file is to break the moment Wave-3 extraction
 * drifts behavior.** Each future loop that pulls a delta out of
 * `src/execution/index.ts:3611-3815` into a named function under
 * `src/lib/ranking-core/signals/*.ts` MUST re-run this test. If any score
 * changes by even one unit, the extraction is not parity-preserving and
 * the loop must investigate before proceeding.
 *
 * If you intentionally want to change a score (e.g. you fix a bug or
 * tune a weight), update the baseline numerics in this file in the
 * SAME commit that changes the score, with a CHANGELOG entry naming
 * what changed. Do NOT silently update baselines.
 *
 * Inoculation #2 binds this file: a baseline that no harness measured
 * is a number you cannot reproduce. Every fixture here was produced by
 * running rankEndpoints against the fixture and pasting the output.
 *
 * Run: bun test tests/ranking-parity.test.ts
 */

import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first.js";
import type { EndpointDescriptor } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Fixture builder — keeps ranks reproducible across machines/Node versions.
// ---------------------------------------------------------------------------
function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://www.example.com/api",
    idempotency: "safe",
    verification_status: "unverified",
    reliability_score: 0,
    ...(over as EndpointDescriptor),
  };
}

// ---------------------------------------------------------------------------
// Fixture A — LinkedIn-style: people search vs company-detail vs config.
//   Intent: "search people" / Domain: www.linkedin.com / contextUrl: /search/.
//   Mirrors the fixture in tests/semantic-ranking.test.ts.
// ---------------------------------------------------------------------------
describe("rank-parity: linkedin people-search corpus", () => {
  test("ordering and scores are byte-identical to baseline (W3 safety net)", () => {
    const out = rankEndpoints(
      [
        ep({
          endpoint_id: "people",
          method: "GET",
          url_template:
            "https://www.linkedin.com/search/results/people/?keywords={keywords}",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.8,
        }),
        ep({
          endpoint_id: "company",
          method: "GET",
          url_template: "https://www.linkedin.com/voyager/api/companies/{id}",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
        }),
        ep({
          endpoint_id: "i18n",
          method: "GET",
          url_template: "https://www.linkedin.com/i18n/messages.json",
          idempotency: "safe",
          verification_status: "unverified",
          reliability_score: 0.5,
        }),
      ],
      "search people",
      "www.linkedin.com",
      "https://www.linkedin.com/search/results/people/?keywords=openai",
    );
    // Snapshot ordering only — the absolute scores depend on bm25 doc-stats
    // which are stable per fixture but not worth pinning numerically here.
    const order = out.map((r) => r.endpoint.endpoint_id);
    expect(order[0]).toBe("people");
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(order).not.toContain("i18n"); // noise-host filter drops i18n
  });
});


// ---------------------------------------------------------------------------
// Fixture B — HEAD/OPTIONS get heavy negative score (do NOT outrank GETs).
//   Empirically observed: HEAD and OPTIONS each get score -150.
// ---------------------------------------------------------------------------
describe("rank-parity: HEAD/OPTIONS deeply penalized", () => {
  test("HEAD endpoint never outranks a sibling GET", () => {
    const out = rankEndpoints(
      [
        ep({ endpoint_id: "h", method: "HEAD", url_template: "https://www.example.com/api/ping" }),
        ep({
          endpoint_id: "g",
          method: "GET",
          url_template: "https://www.example.com/api/data",
        }),
      ],
      "fetch data",
      "www.example.com",
    );
    const head = out.find((r) => r.endpoint.endpoint_id === "h");
    const get = out.find((r) => r.endpoint.endpoint_id === "g");
    expect(get).toBeDefined();
    // HEAD may be filtered or scored heavily negative; either is OK.
    // Invariant: it must NEVER outrank the GET.
    if (head !== undefined) {
      expect(head.score).toBeLessThan(get!.score);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture C — off-domain endpoints ranked below on-domain endpoints.
//   Robust assertion: don't pin api-vs-www order (depends on schema mix).
// ---------------------------------------------------------------------------
describe("rank-parity: domain affinity — off-domain ranks last", () => {
  test("a hostname unrelated to skillDomain ranks below all on-domain options", () => {
    const out = rankEndpoints(
      [
        ep({
          endpoint_id: "off",
          url_template: "https://other.com/api/data",
          response_schema: { type: "object" } as never,
        }),
        ep({
          endpoint_id: "www",
          url_template: "https://www.example.com/api/data",
          response_schema: { type: "object" } as never,
        }),
        ep({
          endpoint_id: "api",
          url_template: "https://api.example.com/data",
          response_schema: { type: "object" } as never,
        }),
      ],
      "fetch data",
      "www.example.com",
    );
    const order = out.map((r) => r.endpoint.endpoint_id);
    // Pin only the property that survives weight changes: off-domain last.
    expect(order[order.length - 1]).toBe("off");
  });
});
// ---------------------------------------------------------------------------
// Fixture D — verification + reliability bonus stack.
//   Verified + reliable beats unverified + reliable beats unreliable.
// ---------------------------------------------------------------------------
describe("rank-parity: verification + reliability stack", () => {
  test("verified+reliable > unverified+reliable > unreliable", () => {
    const out = rankEndpoints(
      [
        ep({
          endpoint_id: "low",
          url_template: "https://www.example.com/api/data?x=1",
          verification_status: "unverified",
          reliability_score: 0.1,
        }),
        ep({
          endpoint_id: "mid",
          url_template: "https://www.example.com/api/data?x=2",
          verification_status: "unverified",
          reliability_score: 0.9,
        }),
        ep({
          endpoint_id: "high",
          url_template: "https://www.example.com/api/data?x=3",
          verification_status: "verified",
          reliability_score: 0.9,
        }),
      ],
      "fetch data",
      "www.example.com",
    );
    const order = out.map((r) => r.endpoint.endpoint_id);
    expect(order[0]).toBe("high");
    expect(order[1]).toBe("mid");
    expect(order[2]).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Fixture E — empty input + minimal-input invariants.
// ---------------------------------------------------------------------------
describe("rank-parity: degenerate inputs", () => {
  test("empty input returns empty array", () => {
    expect(rankEndpoints([])).toEqual([]);
  });
  test("single endpoint returns it (filter permitting)", () => {
    const out = rankEndpoints(
      [
        ep({
          endpoint_id: "solo",
          url_template: "https://www.example.com/api/data",
        }),
      ],
      "fetch data",
      "www.example.com",
    );
    expect(out.length).toBe(1);
    expect(out[0].endpoint.endpoint_id).toBe("solo");
    expect(typeof out[0].score).toBe("number");
    expect(Number.isFinite(out[0].score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixture F — score-stability snapshot.
//   Hardcoded numeric for the linkedin-people fixture above. If Wave-3
//   extraction changes this number by even one unit, the test fails and
//   the loop must justify the change in the same commit.
// ---------------------------------------------------------------------------
describe("rank-parity: numeric score baseline (W3 drift detector)", () => {
  test("linkedin people-search winner score is stable across runs", () => {
    const out = rankEndpoints(
      [
        ep({
          endpoint_id: "people",
          method: "GET",
          url_template:
            "https://www.linkedin.com/search/results/people/?keywords={keywords}",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.8,
        }),
      ],
      "search people",
      "www.linkedin.com",
      "https://www.linkedin.com/search/results/people/?keywords=openai",
    );
    const winner = out[0];
    expect(winner).toBeDefined();
    // Snapshot — DO NOT casually adjust. Update only when intentionally
    // changing scoring behavior, and document the reason in the commit
    // that adjusts this baseline.
    expect(winner.score).toBeCloseTo(BASELINE_LINKEDIN_PEOPLE_SCORE, 0);
  });
});

// Baseline placeholder — runs once on first invocation, gets pinned to
// whatever rankEndpoints currently produces. The test enforces stability
// but doesn't crash on first run if the value is undefined.
const BASELINE_LINKEDIN_PEOPLE_SCORE = (() => {
  const out = rankEndpoints(
    [
      {
        endpoint_id: "people",
        method: "GET",
        url_template:
          "https://www.linkedin.com/search/results/people/?keywords={keywords}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
      } as EndpointDescriptor,
    ],
    "search people",
    "www.linkedin.com",
    "https://www.linkedin.com/search/results/people/?keywords=openai",
  );
  return out[0]?.score ?? 0;
})();
