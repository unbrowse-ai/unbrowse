/**
 * Four outcomes wearing the same clothes.
 *
 * `routes: []` is returned for a dead origin, for a page with genuinely no API,
 * AND for a page whose API was refused by a bot wall. The background-capture
 * caller collapsed the last two, reporting a Cloudflare refusal verbatim as
 * "no API routes discovered (page may be static HTML)".
 *
 * That is not a cosmetic wording bug. The two cases demand opposite responses:
 * a static page will never yield routes however often you retry, while a refused
 * page has the routes and will keep refusing until the wall is cleared. An
 * absence invites the wrong repair — which is the exact sentence I wrote when
 * building the blocked partition, whose signal then had no consumer at all.
 */
import { describe, expect, test } from "bun:test";
import { describeCaptureOutcome } from "../src/values/capture-report.js";

const CF = [{ vendor: "cloudflare" }];

describe("the four outcomes are distinguishable", () => {
  test("routes found -> indexed", () => {
    const o = describeCaptureOutcome({ engine: "obscura", routeCount: 12 });
    expect({ kind: o.kind, shouldIndex: o.shouldIndex }).toEqual({ kind: "indexed", shouldIndex: true });
  });

  test("dead origin -> origin_down, and never indexed", () => {
    const o = describeCaptureOutcome({ engine: "cdp", routeCount: 0, error: "origin_down" });
    expect({ kind: o.kind, shouldIndex: o.shouldIndex }).toEqual({ kind: "origin_down", shouldIndex: false });
  });

  test("refused -> refused, NOT empty — the bug this exists for", () => {
    const o = describeCaptureOutcome({ engine: "obscura", routeCount: 0, blocked: CF });
    expect(o.kind).toBe("refused");
    // The message must carry the actionable half: who refused, and that a plain
    // retry cannot help. A caller reading "static HTML" would retry forever.
    expect(o.message).toContain("cloudflare");
    expect(o.message).toContain("REFUSED");
    expect(o.message).not.toContain("static HTML");
  });

  test("genuinely no API -> empty", () => {
    const o = describeCaptureOutcome({ engine: "cdp", routeCount: 0 });
    expect(o.kind).toBe("empty");
    expect(o.message).toContain("static HTML");
  });
});

describe("precedence and partial cases", () => {
  test("a dead origin outranks a refusal — nothing was received to refuse", () => {
    const o = describeCaptureOutcome({ engine: "obscura", routeCount: 0, blocked: CF, error: "origin_down" });
    expect(o.kind).toBe("origin_down");
  });

  test("PARTIAL refusal still indexes what it has, and still says what it lost", () => {
    // The route count alone cannot show that the index is incomplete.
    const o = describeCaptureOutcome({ engine: "obscura", routeCount: 5, blocked: CF });
    expect({ kind: o.kind, shouldIndex: o.shouldIndex }).toEqual({ kind: "indexed", shouldIndex: true });
    expect(o.message).toContain("refused");
    expect(o.message).toContain("cloudflare");
  });

  test("several vendors are all named, deduped, order stable", () => {
    const o = describeCaptureOutcome({
      engine: "obscura",
      routeCount: 0,
      blocked: [{ vendor: "cloudflare" }, { vendor: "datadome" }, { vendor: "cloudflare" }],
    });
    expect(o.message).toContain("cloudflare,datadome");
  });

  test("only 'indexed' ever writes to the index", () => {
    // The safety property: three of four outcomes must never publish.
    const cases = [
      { engine: "e", routeCount: 0 },
      { engine: "e", routeCount: 0, blocked: CF },
      { engine: "e", routeCount: 0, error: "origin_down" },
    ];
    expect(cases.map((c) => describeCaptureOutcome(c).shouldIndex)).toEqual([false, false, false]);
  });
});
