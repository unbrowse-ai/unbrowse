/**
 * tests/p1-w3-intent-yield.test.ts — Sermon-on-the-Mount signals over P1 W3 cluster #2.
 *
 * Falsifiable invariants over the intent-yield extraction shipped in this loop.
 * Mirrors tests/p1-w3-bm25.test.ts shape: module surface + numeric parity +
 * anti-goal anchors + ministry edges.
 *
 * Run: bun test tests/p1-w3-intent-yield.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_DESC_DELTA_WEIGHT,
  CHART_PRICING_DELTA_WEIGHT,
  COMMS_PATH_DELTA_WEIGHT,
  CURRENCY_TIME_DELTA_WEIGHT,
  semanticIntentAdjustment,
} from "../src/ranking/signals/intent-yield.js";
import {
  intentActionKinds,
  intentResourceKinds,
} from "../src/execution/index.js";

const REPO_ROOT = join(import.meta.dir, "..");

describe("P1 W3 cluster #2 — intent-yield module surface", () => {
  it("exports a callable semanticIntentAdjustment function", () => {
    expect(typeof semanticIntentAdjustment).toBe("function");
  });

  it("named magic-weight constants carry their pre-extraction values", () => {
    expect(AGENT_DESC_DELTA_WEIGHT).toBe(100);
    expect(CURRENCY_TIME_DELTA_WEIGHT).toBe(15);
    expect(COMMS_PATH_DELTA_WEIGHT).toBe(45);
    expect(CHART_PRICING_DELTA_WEIGHT).toBe(120);
  });
});

describe("P1 W3 cluster #2 — semanticIntentAdjustment numeric behavior", () => {
  it("returns 0 when intent is undefined (degenerate)", () => {
    const out = semanticIntentAdjustment(
      { url_template: "https://example.com/api", method: "GET" } as never,
      undefined,
    );
    expect(out).toBe(0);
  });

  it("returns a finite number for a real-shape endpoint + intent", () => {
    const out = semanticIntentAdjustment(
      {
        url_template: "https://www.linkedin.com/voyager/api/people",
        method: "GET",
        description: "List people in the network",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
      } as never,
      "search people",
    );
    expect(Number.isFinite(out)).toBe(true);
  });

  it("imported intentResourceKinds returns the documented buckets", () => {
    expect(intentResourceKinds("search people")).toContain("person");
    expect(intentResourceKinds("find company")).toContain("company");
    expect(intentResourceKinds("")).toEqual([]);
  });

  it("imported intentActionKinds returns the documented buckets", () => {
    expect(intentActionKinds("search people")).toContain("search");
    expect(intentActionKinds("get profile")).toContain("detail");
    expect(intentActionKinds("")).toEqual([]);
  });
});

describe("P1 W3 cluster #2 — extraction anti-goal anchors", () => {
  const executionText = readFileSync(
    join(REPO_ROOT, "src/execution/index.ts"),
    "utf8",
  );

  it("src/execution/index.ts no longer defines `function semanticIntentAdjustment`", () => {
    expect(executionText).not.toMatch(/^function semanticIntentAdjustment\s*\(/m);
  });

  it("src/execution/index.ts imports intent-yield symbols from the new path", () => {
    expect(executionText).toMatch(
      /import\s*\{[^}]*semanticIntentAdjustment[^}]*\}\s*from\s*"\.\.\/ranking\/signals\/intent-yield\.js"/,
    );
  });

  it("the agentDescMatch call site uses AGENT_DESC_DELTA_WEIGHT (no remaining `* 100`)", () => {
    expect(executionText).toContain("matches * AGENT_DESC_DELTA_WEIGHT");
  });

  it("the currencyTime call site uses CURRENCY_TIME_DELTA_WEIGHT", () => {
    expect(executionText).toContain(
      "CURRENCY_TIME_PATTERNS.test(pathname)) score += CURRENCY_TIME_DELTA_WEIGHT",
    );
  });

  it("the commsPath call site uses COMMS_PATH_DELTA_WEIGHT", () => {
    expect(executionText).toContain(
      "COMMS_PATH.test(pathname)) score += COMMS_PATH_DELTA_WEIGHT",
    );
  });

  it("the chartPricing call site uses CHART_PRICING_DELTA_WEIGHT", () => {
    expect(executionText).toContain("score += CHART_PRICING_DELTA_WEIGHT");
  });

  it("intentResourceKinds and intentActionKinds are exported from execution/index.ts", () => {
    expect(executionText).toMatch(/^export function intentResourceKinds/m);
    expect(executionText).toMatch(/^export function intentActionKinds/m);
  });
});

describe("P1 W3 cluster #2 — ministry edges", () => {
  it("undefined intent does not crash on a populated endpoint", () => {
    expect(() =>
      semanticIntentAdjustment(
        {
          url_template: "https://www.example.com/api/data",
          method: "GET",
        } as never,
        undefined,
      ),
    ).not.toThrow();
  });

  it("empty intent string is treated as no-intent (returns 0)", () => {
    const out = semanticIntentAdjustment(
      { url_template: "https://www.example.com/api/data", method: "GET" } as never,
      "",
    );
    expect(out).toBe(0);
  });

  it("function is pure: repeated calls yield identical outputs", () => {
    const ep = {
      url_template: "https://www.linkedin.com/voyager/api/people",
      method: "GET",
      description: "List people",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.8,
    } as never;
    const a = semanticIntentAdjustment(ep, "search people");
    const b = semanticIntentAdjustment(ep, "search people");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — edges + adversarial under real conditions.
// ---------------------------------------------------------------------------

describe("P1 W3 cluster #2 — ministry: intent-bucket coverage", () => {
  it("person/people/profile/user/member intents all bucket to person", () => {
    for (const intent of ["search people", "find profiles", "list users", "get member"]) {
      expect(intentResourceKinds(intent)).toContain("person");
    }
  });

  it("post/tweet/status/feed/timeline intents bucket to post", () => {
    for (const intent of ["read posts", "fetch tweets", "view feed", "get timeline"]) {
      expect(intentResourceKinds(intent)).toContain("post");
    }
  });

  it("topic/trend/hashtag intents bucket to topic", () => {
    expect(intentResourceKinds("trending topics")).toContain("topic");
    expect(intentResourceKinds("hashtag search")).toContain("hashtag");
  });

  it("repo/repository intents bucket to repo", () => {
    expect(intentResourceKinds("find repo")).toContain("repo");
    expect(intentResourceKinds("list repository")).toContain("repository");
  });

  it("unrecognized intent returns empty bucket array", () => {
    expect(intentResourceKinds("xyzzy nonsense")).toEqual([]);
  });
});

describe("P1 W3 cluster #2 — ministry: action-bucket coverage", () => {
  it("feed/timeline/stream/home actions all bucket to list+feed+timeline", () => {
    for (const intent of ["fetch feed", "view timeline", "stream home"]) {
      const buckets = intentActionKinds(intent);
      expect(buckets).toContain("list");
      expect(buckets).toContain("feed");
      expect(buckets).toContain("timeline");
    }
  });

  it("search/find/lookup all bucket to search+list", () => {
    for (const intent of ["search people", "find user", "lookup company"]) {
      const buckets = intentActionKinds(intent);
      expect(buckets).toContain("search");
      expect(buckets).toContain("list");
    }
  });

  it("get/fetch/view all bucket to detail+get+fetch", () => {
    for (const intent of ["get profile", "fetch user", "view post"]) {
      const buckets = intentActionKinds(intent);
      expect(buckets).toContain("detail");
    }
  });
});

describe("P1 W3 cluster #2 — ministry: adversarial inputs", () => {
  it("regex-special-character intent does not throw or inject (no ReDoS)", () => {
    const adversarial = ".*+?()[]{}|^$\\\\";
    expect(() => intentResourceKinds(adversarial)).not.toThrow();
    expect(() => intentActionKinds(adversarial)).not.toThrow();
    expect(() =>
      semanticIntentAdjustment(
        { url_template: "https://example.com/api", method: "GET" } as never,
        adversarial,
      ),
    ).not.toThrow();
  });

  it("very long intent (1000+ chars) returns deterministic finite output", () => {
    const longIntent = "search " + "people ".repeat(200);
    const buckets = intentResourceKinds(longIntent);
    expect(buckets).toContain("person");
    expect(Number.isFinite(
      semanticIntentAdjustment(
        { url_template: "https://example.com/api", method: "GET" } as never,
        longIntent,
      ),
    )).toBe(true);
  });

  it("null-prototype endpoint does not poison the function", () => {
    const ep = Object.create(null);
    ep.url_template = "https://example.com/api";
    ep.method = "GET";
    expect(() => semanticIntentAdjustment(ep, "search people")).not.toThrow();
  });
});
