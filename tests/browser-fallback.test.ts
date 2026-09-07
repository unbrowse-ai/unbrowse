/**
 * GATE: the browser is the floor under a missing index — and nothing more.
 *
 * The behaviour under test: when search/index/direct-document produce nothing
 * usable, open the browser rather than returning the miss. The risk under test
 * is the inverse — this decision sits on the hot path of EVERY shipped call, so
 * a version that escalates too eagerly spawns a browser on every failure.
 *
 * So both directions are pinned: it fires on a miss, and it must NOT fire when
 * auth or payment is the wall (a browser cannot supply a session or a payment
 * the caller lacks), when a browser already opened (that is how a floor becomes
 * an infinite ladder), or inside the pointer-pipe walk (which would double-open).
 *
 * The fixtures below are copied VERBATIM from the result literals in
 * `enforceIntentResultTruth`, and the last describe block re-reads that source to
 * prove they still match. That guard exists because the first version of this
 * file tested an invented list of error names against itself and passed — three
 * of those names ("no_results", "no_endpoint", "empty_shortlist") existed
 * nowhere in src/. A gate that grades its own fiction is not a gate.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  shouldFallbackToBrowser,
  fallbackImproved,
  carryBrowserOpened,
  markBarrenPage,
  isBarrenPage,
  _resetBarrenPages,
  BARREN_PAGE_TTL_MS,
} from "../src/orchestrator/browser-fallback.js";
import { routeIdentityForUrl, cachedSkillHostMatchesContext } from "../src/orchestrator/index.js";

const ctx = { url: "https://quotes.toscrape.com/scroll" };

/** Verbatim from enforceIntentResultTruth — the concrete-URL/collection mismatch. */
const shapeMismatch = {
  trace: { success: false, error: "response_shape_mismatch" },
  result: {
    error: "response_shape_mismatch",
    message: "A concrete detail URL was answered by a collection route.",
    observed_cardinality: 10,
    task_ok: false,
    intent_applied: true,
    intent_fulfilled: false,
  },
};

/** Verbatim from enforceIntentResultTruth — the protected-target refusal. */
const authRefusal = {
  trace: { success: false, error: "authenticated_evidence_required" },
  result: {
    error: "authenticated_evidence_required",
    blocker: "auth",
    message: "A protected browser target cannot pass without authenticated-session evidence.",
    auth_required: true,
    auth_ok: false,
    task_ok: false,
    intent_fulfilled: false,
  },
};

describe("shouldFallbackToBrowser — when the fast paths came back empty", () => {
  test("escalates on the shape mismatch staging actually produced", () => {
    // The observed live chain: index returns 0 results -> direct-document
    // guesses /search.aspx -> wrong shape -> previously terminal.
    const d = shouldFallbackToBrowser(shapeMismatch, ctx);
    expect(d.escalate).toBe(true);
    expect(d.reason).toContain("response_shape_mismatch");
  });

  test("escalates on a failure nobody has named yet (no allowlist to extend)", () => {
    // This is the generalisation that matters: a new failure mode gets the
    // browser floor for free. An enumerated trigger list would miss it.
    const d = shouldFallbackToBrowser({ trace: { success: false, error: "some_brand_new_error" } }, ctx);
    expect(d.escalate).toBe(true);
  });

  test("escalates on an anti-bot challenge — that is what a browser is FOR", () => {
    const d = shouldFallbackToBrowser(
      { trace: { success: false, error: "challenge" }, result: { blocker: "challenge" } },
      ctx,
    );
    expect(d.escalate).toBe(true);
  });
});

describe("shouldFallbackToBrowser — the guards that keep it cheap", () => {
  test("a successful verdict is never re-run", () => {
    const d = shouldFallbackToBrowser({ trace: { success: true } }, ctx);
    expect(d.escalate).toBe(false);
    expect(d.reason).toBe("verdict_succeeded");
  });

  test("does NOT escalate on auth — a browser cannot supply a session we lack", () => {
    const d = shouldFallbackToBrowser(authRefusal, ctx);
    expect(d.escalate).toBe(false);
    expect(d.reason).toBe("auth_blocked_browser_cannot_fix");
  });

  test("recognises auth by shape, not by error name", () => {
    // Same wall, different (unnamed) error — still excluded.
    for (const result of [{ blocker: "auth" }, { auth_required: true }, { auth_ok: false }]) {
      const d = shouldFallbackToBrowser({ trace: { success: false, error: "renamed_later" }, result }, ctx);
      expect(d.escalate, `${JSON.stringify(result)} must not spawn a browser`).toBe(false);
    }
  });

  test("does NOT escalate on payment", () => {
    expect(shouldFallbackToBrowser({ trace: { success: false, error: "payment_required" } }, ctx).escalate).toBe(false);
    expect(
      shouldFallbackToBrowser(
        { trace: { success: false, error: "x" }, result: { payment_status: "payment_required" } },
        ctx,
      ).escalate,
    ).toBe(false);
  });

  test("does NOT escalate when a browser was already opened", () => {
    const d = shouldFallbackToBrowser({ ...shapeMismatch, timing: { browser_opened: true } }, ctx);
    expect(d.escalate).toBe(false);
    expect(d.reason).toBe("browser_already_opened");
  });

  test("does NOT escalate from inside the pointer-pipe walk", () => {
    // The exa->candidate walk re-enters the PUBLIC resolveAndExecute. Escalating
    // there AND at the outer level opens two browsers for one user call.
    const d = shouldFallbackToBrowser(shapeMismatch, ctx, 1);
    expect(d.escalate).toBe(false);
    expect(d.reason).toBe("inner_walk_defers_to_outer");
  });

  test("does NOT escalate with no URL to descend into", () => {
    expect(shouldFallbackToBrowser(shapeMismatch, {}).escalate).toBe(false);
    expect(shouldFallbackToBrowser(shapeMismatch, { url: "  " }).escalate).toBe(false);
  });
});

describe("fallbackImproved — a failed rescue never overwrites the diagnosis", () => {
  test("adopts the retry only when it actually succeeded", () => {
    expect(fallbackImproved(shapeMismatch, { trace: { success: true } })).toBe(true);
  });

  test("keeps the original when the browser failed too", () => {
    expect(fallbackImproved(shapeMismatch, { trace: { success: false, error: "capture_timeout" } })).toBe(false);
  });
});

describe("carryBrowserOpened — a failed rescue still admits the browser opened", () => {
  test("a browser that opened during the attempt is reported on the returned verdict", () => {
    // Measured on a static page with no API calls: Chrome opened, captured for
    // 14s, found 0 requests, lost. Returning the original verdict unchanged
    // would report browser_opened:false for a call that opened a browser.
    const out = carryBrowserOpened(shapeMismatch, { trace: { success: false }, timing: { browser_opened: true } });
    expect(out.timing?.browser_opened).toBe(true);
    // The diagnosis itself is untouched — only the observation is carried.
    expect(out.trace.error).toBe("response_shape_mismatch");
    expect(out.trace.success).toBe(false);
  });

  test("no browser opened -> nothing is claimed", () => {
    expect(carryBrowserOpened(shapeMismatch, { trace: { success: false } }).timing?.browser_opened).toBeUndefined();
    expect(
      carryBrowserOpened(shapeMismatch, { trace: { success: false }, timing: { browser_opened: false } })
        .timing?.browser_opened,
    ).toBeUndefined();
  });
});

describe("the fixtures are real (anti-fabrication gate)", () => {
  const orchestrator = readFileSync(
    join(import.meta.dirname, "..", "src", "orchestrator", "index.ts"),
    "utf8",
  );

  test("the auth fields this decision keys on are really emitted by the orchestrator", () => {
    // If someone renames these, the exclusion silently stops working and every
    // auth failure starts spawning a browser. Fail here instead.
    expect(orchestrator).toContain('blocker: "auth"');
    expect(orchestrator).toContain("auth_required: true");
    expect(orchestrator).toContain("auth_ok: false");
  });

  test("response_shape_mismatch is a real terminal error, not an invented one", () => {
    expect(orchestrator).toContain('const error = "response_shape_mismatch"');
  });

  test("the decision is actually deciding (guards a vacuous pass)", () => {
    expect(shouldFallbackToBrowser(shapeMismatch, ctx).escalate).toBe(true);
    expect(shouldFallbackToBrowser(authRefusal, ctx).escalate).toBe(false);
  });
});

describe("barren-page memory — a fruitless rescue is not re-paid", () => {
  test("a page marked barren stops escalating for the same intent", () => {
    _resetBarrenPages();
    const intent = "get the product details";
    // Before: a shape mismatch escalates.
    expect(shouldFallbackToBrowser(shapeMismatch, ctx, 0, intent).escalate).toBe(true);
    // A rescue ran, opened a browser, and found nothing.
    markBarrenPage(intent, ctx.url);
    const d = shouldFallbackToBrowser(shapeMismatch, ctx, 0, intent);
    expect(d.escalate).toBe(false);
    expect(d.reason).toBe("page_known_barren");
  });

  test("barren is scoped to intent+url, not to the whole page", () => {
    _resetBarrenPages();
    markBarrenPage("get the product details", ctx.url);
    // A DIFFERENT intent against the same page may well find something.
    expect(shouldFallbackToBrowser(shapeMismatch, ctx, 0, "list every review").escalate).toBe(true);
    // A different page is unaffected.
    expect(
      shouldFallbackToBrowser(shapeMismatch, { url: "https://example.com/other" }, 0, "get the product details").escalate,
    ).toBe(true);
  });

  test("the memory EXPIRES — a site that ships an API later is not permanently invisible", () => {
    _resetBarrenPages();
    const t0 = 1_000_000;
    markBarrenPage("i", "https://x.test/p", t0);
    expect(isBarrenPage("i", "https://x.test/p", t0 + 1_000)).toBe(true);
    expect(isBarrenPage("i", "https://x.test/p", t0 + BARREN_PAGE_TTL_MS + 1)).toBe(false);
  });

  test("with no intent supplied the guard cannot fire (never a silent block)", () => {
    _resetBarrenPages();
    markBarrenPage("get the product details", ctx.url);
    expect(shouldFallbackToBrowser(shapeMismatch, ctx, 0, undefined).escalate).toBe(true);
  });
});

describe("routeIdentityForUrl — the identity the route cache asks for", () => {
  test("port-qualifies local targets, where the port IS the application", () => {
    expect(routeIdentityForUrl("http://localhost:35737/a", "localhost")).toBe("localhost:35737");
    expect(routeIdentityForUrl("http://127.0.0.1:8080/a", "127.0.0.1")).toBe("127.0.0.1:8080");
  });

  test("leaves public hosts exactly as they were", () => {
    // Must NOT silently re-key every existing skill via routeScopeHost's www-stripping.
    expect(routeIdentityForUrl("https://www.example.com/a", "www.example.com")).toBe("www.example.com");
    expect(routeIdentityForUrl("https://example.com/a", "example.com")).toBe("example.com");
  });

  test("the identity it returns is one cachedSkillHostMatchesContext accepts", () => {
    // This is the whole point: what the writer stores must match what the reader asks.
    const url = "http://localhost:35737/product/1";
    expect(cachedSkillHostMatchesContext(routeIdentityForUrl(url, "localhost"), url)).toBe(true);
    // The pre-fix value did not match — that is why local routes never replayed.
    expect(cachedSkillHostMatchesContext("localhost", url)).toBe(false);
  });

  test("it does NOT collapse different ports into one identity", () => {
    // localhost:3000 and localhost:4000 are different applications.
    expect(cachedSkillHostMatchesContext(routeIdentityForUrl("http://localhost:3000/a", "localhost"),
      "http://localhost:4000/a")).toBe(false);
  });

  test("no url -> falls back to the hostname rather than throwing", () => {
    expect(routeIdentityForUrl(undefined, "example.com")).toBe("example.com");
  });
});
