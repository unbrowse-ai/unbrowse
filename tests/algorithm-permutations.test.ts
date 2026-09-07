/**
 * THE PERMUTATION MATRIX — every state the unbrowse decision layer can be in.
 *
 * Example-based tests check the states someone thought of. This file enumerates
 * the FULL cross-product of every input dimension the decision layer reads, and
 * asserts the design's invariants hold in every cell. The difference matters:
 * three of this session's bugs were states nobody enumerated —
 *
 *   - a fallback that fired inside the pointer-pipe walk (double browser launch),
 *   - a rescue that reported `browser_opened:false` after opening a browser,
 *   - a route stored under an identity the reader could never match.
 *
 * Each was one unenumerated combination. A matrix finds that class by
 * construction rather than by imagination.
 *
 * WHY THIS IS EXHAUSTIVE AND NOT A SAMPLE: every function under test here is
 * PURE — same inputs, same output, no I/O. So the input space is finite and
 * small enough to walk completely. The ladder itself (network, browser, caches)
 * is not pure and is covered by the integration gates instead; this file draws
 * the line at the decision layer on purpose and says so rather than pretending
 * to cover what it cannot.
 *
 * Invariants, not snapshots. A snapshot test says "the answer is still what it
 * was"; these say "the answer is still SAFE" — a browser is never opened for a
 * wall it cannot climb, a private capture never becomes public, a learned route
 * is never stored where it cannot be found. Those are the properties that must
 * survive any future refactor of how the answers are computed.
 */

import { test, expect, describe } from "bun:test";
import {
  shouldFallbackToBrowser,
  carryBrowserOpened,
  fallbackImproved,
  markBarrenPage,
  isBarrenPage,
  exportBarrenPages,
  hydrateBarrenPages,
  BARREN_PAGE_TTL_MS,
  _resetBarrenPages,
  type FallbackJudgment,
} from "../src/orchestrator/browser-fallback.js";
import {
  routeIdentityForUrl,
  cachedSkillHostMatchesContext,
  carriesReplayableEndpoint,
} from "../src/orchestrator/index.js";
import { shouldPublishAfterIndex } from "../src/lib/indexer-core/index.js";

/** Cartesian product of the given dimensions. */
function permute<T extends Record<string, readonly unknown[]>>(dims: T): Array<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(dims) as Array<keyof T>;
  let rows: Array<Record<string, unknown>> = [{}];
  for (const k of keys) {
    const next: Array<Record<string, unknown>> = [];
    for (const row of rows) for (const v of dims[k]) next.push({ ...row, [k as string]: v });
    rows = next;
  }
  return rows as Array<{ [K in keyof T]: T[K][number] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE BROWSER-FALLBACK STATE SPACE
// ─────────────────────────────────────────────────────────────────────────────

/** Result shapes the orchestrator's truth gates actually emit. */
const RESULT_SHAPES = {
  none: undefined,
  authBlocker: { blocker: "auth", auth_required: true, auth_ok: false },
  authRequiredOnly: { auth_required: true },
  authOkFalse: { auth_ok: false },
  paymentStatus: { payment_status: "payment_required" },
  challenge: { blocker: "challenge" },
  plainMiss: { task_ok: false, intent_fulfilled: false },
} as const;

const FALLBACK_DIMS = {
  success: [true, false, undefined],
  error: [
    "",
    "response_shape_mismatch",
    "no_cached_match",
    "authenticated_evidence_required",
    "payment_required",
    "challenge",
    // A dead origin, wrapped the way the orchestrator actually emits it, so the
    // substring match is exercised rather than an exact-equality shortcut.
    "origin_down (getaddrinfo ENOTFOUND swapi.dev)",
    "an_error_nobody_has_named_yet",
  ],
  shape: Object.keys(RESULT_SHAPES) as Array<keyof typeof RESULT_SHAPES>,
  browserOpened: [true, false, undefined],
  walkDepth: [0, 1, undefined],
  url: ["https://example.com/thing", "", "   "],
  barren: [true, false],
} as const;

const INTENT = "list the items";

function buildJudgment(row: {
  success: boolean | undefined;
  error: string;
  shape: keyof typeof RESULT_SHAPES;
  browserOpened: boolean | undefined;
}): FallbackJudgment {
  return {
    trace: { success: row.success, error: row.error },
    result: RESULT_SHAPES[row.shape],
    timing: { browser_opened: row.browserOpened },
  };
}

const isAuthShaped = (shape: keyof typeof RESULT_SHAPES) =>
  shape === "authBlocker" || shape === "authRequiredOnly" || shape === "authOkFalse";
const isPaymentShaped = (shape: keyof typeof RESULT_SHAPES, error: string) =>
  shape === "paymentStatus" || error === "payment_required";
/**
 * A transport-layer failure to reach the origin. Asserted independently of
 * `isOriginUnreachableError` (a re-implementation, not an import) so the test
 * cannot agree with the implementation by sharing its bug.
 */
const isOriginDead = (error: string) => /origin_down|origin_dns|enotfound|getaddrinfo/i.test(error);

describe("PERMUTATION MATRIX — browser fallback", () => {
  const rows = permute(FALLBACK_DIMS);

  test("the matrix is actually large (guards a silently-shrunk sweep)", () => {
    // 3 * 8 * 7 * 3 * 3 * 3 * 2
    expect(rows.length).toBe(9072);
  });

  test("every cell satisfies every safety invariant", () => {
    const violations: string[] = [];
    let escalations = 0;

    for (const row of rows) {
      _resetBarrenPages();
      if (row.barren && row.url.trim()) markBarrenPage(INTENT, row.url.trim());

      const judged = buildJudgment(row);
      const d = shouldFallbackToBrowser(judged, { url: row.url }, row.walkDepth, INTENT);
      const where = JSON.stringify(row);

      // Every decision must explain itself — a silent skip is undebuggable.
      if (!d.reason || d.reason.length === 0) violations.push(`empty reason @ ${where}`);

      if (d.escalate) {
        escalations++;
        // I1 — never re-run a verdict that did not fail.
        if (row.success !== false) violations.push(`escalated on non-failure @ ${where}`);
        // I2 — never escalate without somewhere to go.
        if (!row.url.trim()) violations.push(`escalated with no url @ ${where}`);
        // I3 — the floor is not a ladder.
        if (row.browserOpened === true) violations.push(`escalated after a browser opened @ ${where}`);
        // I4 — the pointer-pipe walk defers to the outer call.
        if ((row.walkDepth ?? 0) > 0) violations.push(`escalated inside the walk @ ${where}`);
        // I5/I6 — a browser cannot supply a session or a payment.
        if (isAuthShaped(row.shape)) violations.push(`escalated on an auth wall @ ${where}`);
        if (isPaymentShaped(row.shape, row.error)) violations.push(`escalated on a payment wall @ ${where}`);
        // I7 — never re-pay for a page already known to hold nothing.
        if (row.barren) violations.push(`escalated on a barren page @ ${where}`);
        // I8 — a browser resolves the same DNS and opens the same socket, so an
        // origin that never answered cannot be rescued by opening one.
        if (isOriginDead(row.error)) violations.push(`escalated on a dead origin @ ${where}`);
      }
    }

    expect(violations.slice(0, 10)).toEqual([]);
    expect(violations.length).toBe(0);
    // Non-vacuous: a matrix where nothing ever escalates proves nothing.
    expect(escalations).toBeGreaterThan(0);
  });

  test("the matrix exercises BOTH outcomes in meaningful numbers", () => {
    let yes = 0, no = 0;
    for (const row of rows) {
      // The barren state must actually be APPLIED, or rows differing only in
      // `barren` are the same test run twice and the dimension is decorative.
      _resetBarrenPages();
      if (row.barren && row.url.trim()) markBarrenPage(INTENT, row.url.trim());
      const d = shouldFallbackToBrowser(buildJudgment(row), { url: row.url }, row.walkDepth, INTENT);
      d.escalate ? yes++ : no++;
    }
    expect(yes).toBeGreaterThan(50);
    expect(no).toBeGreaterThan(50);
    expect(yes + no).toBe(rows.length);
  });

  test("the barren dimension actually changes outcomes (guards a decorative dimension)", () => {
    // If marking a page barren never flips a decision, the dimension is inert
    // and half the cross-product is a duplicate of the other half.
    let flipped = 0;
    for (const row of rows) {
      if (!row.url.trim()) continue;
      _resetBarrenPages();
      const before = shouldFallbackToBrowser(buildJudgment(row), { url: row.url }, row.walkDepth, INTENT);
      markBarrenPage(INTENT, row.url.trim());
      const after = shouldFallbackToBrowser(buildJudgment(row), { url: row.url }, row.walkDepth, INTENT);
      if (before.escalate !== after.escalate) flipped++;
    }
    expect(flipped).toBeGreaterThan(0);
  });

  test("the decision is deterministic across the whole matrix", () => {
    for (const row of rows) {
      _resetBarrenPages();
      if (row.barren && row.url.trim()) markBarrenPage(INTENT, row.url.trim());
      const a = shouldFallbackToBrowser(buildJudgment(row), { url: row.url }, row.walkDepth, INTENT);
      const b = shouldFallbackToBrowser(buildJudgment(row), { url: row.url }, row.walkDepth, INTENT);
      expect(b).toEqual(a);
    }
  });

  test("carryBrowserOpened never downgrades an observation, in any cell", () => {
    for (const row of rows) {
      const judged = buildJudgment(row);
      for (const attemptOpened of [true, false, undefined]) {
        const out = carryBrowserOpened(judged, { trace: {}, timing: { browser_opened: attemptOpened } });
        // Truth is monotonic: if either the verdict or the attempt opened a
        // browser, the returned verdict must admit it.
        const expected = row.browserOpened === true || attemptOpened === true ? true : row.browserOpened;
        expect(out.timing?.browser_opened).toBe(expected);
        // and the diagnosis itself is never altered
        expect(out.trace.error).toBe(judged.trace.error);
        expect(out.trace.success).toBe(judged.trace.success);
      }
    }
  });

  test("fallbackImproved adopts a retry ONLY on a real success", () => {
    for (const row of rows) {
      const judged = buildJudgment(row);
      for (const retriedSuccess of [true, false, undefined]) {
        const improved = fallbackImproved(judged, { trace: { success: retriedSuccess } });
        expect(improved).toBe(retriedSuccess === true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PUBLISH STATE SPACE — where privacy actually lives
// ─────────────────────────────────────────────────────────────────────────────

describe("PERMUTATION MATRIX — publish gates", () => {
  const rows = permute({
    sharePointers: [true, false],
    autoReview: [true, false, undefined],
    reviewed: [true, false],
  });

  test("every cell: share_pointers=false NEVER yields a public visibility", () => {
    // The single most consequential invariant in the product. If this ever
    // fails, a user who opted out is published anyway.
    for (const row of rows) {
      const d = shouldPublishAfterIndex(
        { skill_id: "s", ...(row.reviewed ? { reviewed_at: new Date().toISOString() } : {}) },
        { share_pointers: row.sharePointers, auto_review: row.autoReview },
      );
      if (!row.sharePointers) {
        expect(d.visibility, JSON.stringify(row)).toBe("private");
        expect(d.gate).toBe("share_pointers_off");
      }
    }
  });

  test("every cell: an unreviewed skill is public ONLY via an explicit auto_review", () => {
    for (const row of rows) {
      const d = shouldPublishAfterIndex(
        { skill_id: "s", ...(row.reviewed ? { reviewed_at: "2026-01-01T00:00:00Z" } : {}) },
        { share_pointers: row.sharePointers, auto_review: row.autoReview },
      );
      if (row.sharePointers && !row.reviewed) {
        expect(d.publish, JSON.stringify(row)).toBe(row.autoReview === true);
        expect(d.gate).toBe(row.autoReview === true ? "auto_review" : "awaiting_review");
      }
    }
  });

  test("every cell: publish=false implies visibility is never public", () => {
    for (const row of rows) {
      const d = shouldPublishAfterIndex(
        { skill_id: "s", ...(row.reviewed ? { reviewed_at: "2026-01-01T00:00:00Z" } : {}) },
        { share_pointers: row.sharePointers, auto_review: row.autoReview },
      );
      if (!d.publish) expect(d.visibility).toBe("private");
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  test("the auto_review door never forges a reviewed_at stamp", () => {
    // reviewed_at is provenance that a human/agent review happened. The gate may
    // publish without it, but must never invent it.
    const d = shouldPublishAfterIndex({ skill_id: "s" }, { share_pointers: true, auto_review: true });
    expect(d.publish).toBe(true);
    expect(d.gate).toBe("auto_review");
    expect((d as Record<string, unknown>).reviewed_at).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ROUTE-IDENTITY STATE SPACE — write it where the reader will look
// ─────────────────────────────────────────────────────────────────────────────

describe("PERMUTATION MATRIX — route identity", () => {
  const HOSTS = [
    { host: "example.com", portSensitive: false },
    { host: "www.example.com", portSensitive: false },
    { host: "sub.example.co.uk", portSensitive: false },
    { host: "localhost", portSensitive: true },
    { host: "127.0.0.1", portSensitive: true },
  ] as const;
  const PORTS = ["", ":3000", ":8080"] as const;
  const SCHEMES = ["http://", "https://"] as const;

  test("round-trip: what the writer stores, the reader accepts — every cell", () => {
    const violations: string[] = [];
    for (const { host } of HOSTS) {
      for (const port of PORTS) {
        for (const scheme of SCHEMES) {
          const url = `${scheme}${host}${port}/some/path?q=1`;
          const stored = routeIdentityForUrl(url, host);
          if (!cachedSkillHostMatchesContext(stored, url)) {
            violations.push(`${url} stored as ${stored} — reader rejects it`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("distinct ports on a local host are NEVER the same application", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      const a = routeIdentityForUrl(`http://${host}:3000/x`, host);
      expect(cachedSkillHostMatchesContext(a, `http://${host}:4000/x`)).toBe(false);
    }
  });

  test("public hosts are never silently re-keyed", () => {
    for (const { host, portSensitive } of HOSTS) {
      if (portSensitive) continue;
      for (const scheme of SCHEMES) {
        expect(routeIdentityForUrl(`${scheme}${host}/a`, host)).toBe(host);
      }
    }
  });

  test("a missing or unparseable url degrades to the hostname, never throws", () => {
    expect(routeIdentityForUrl(undefined, "example.com")).toBe("example.com");
    expect(routeIdentityForUrl("", "example.com")).toBe("example.com");
    expect(routeIdentityForUrl("not a url", "example.com")).toBe("example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. REPLAYABILITY — "can this be executed again?", not "who produced it?"
// ─────────────────────────────────────────────────────────────────────────────

describe("PERMUTATION MATRIX — replayable-route recognition", () => {
  const ep = (over: Record<string, unknown> = {}) =>
    ({ endpoint_id: "e", method: "GET", url_template: "https://api.example.com/items", ...over }) as never;

  test("recognises by shape across every endpoint permutation", () => {
    const rows = permute({
      method: ["GET", "POST", "", undefined],
      url: ["https://api.example.com/items", "http://localhost:3000/x", "/relative/path", "", undefined],
    });
    for (const row of rows) {
      const skill = { endpoints: [ep({ method: row.method, url_template: row.url })] };
      const expected =
        typeof row.method === "string" && row.method.trim().length > 0 &&
        typeof row.url === "string" && /^https?:\/\//i.test(row.url);
      expect(carriesReplayableEndpoint(skill), JSON.stringify(row)).toBe(expected);
    }
  });

  test("the OBSERVED failing case: a dom-fallback skill with zero endpoints", () => {
    // Measured live — a browser rescue that extracted DOM content produced a
    // skill carrying no endpoints at all. There is genuinely nothing to replay,
    // and the structural test says so without naming the source.
    expect(carriesReplayableEndpoint({ endpoints: [] })).toBe(false);
    expect(carriesReplayableEndpoint({ endpoints: undefined as never })).toBe(false);
    expect(carriesReplayableEndpoint(null)).toBe(false);
    expect(carriesReplayableEndpoint(undefined)).toBe(false);
  });

  test("one replayable endpoint among unusable ones is still replayable", () => {
    expect(carriesReplayableEndpoint({
      endpoints: [ep({ url_template: "/relative" }), ep({ method: "" }), ep()],
    })).toBe(true);
  });

  test("source name is NOT consulted (the allowlist this replaced)", () => {
    // The old test named four sources and silently excluded the rest. Identical
    // endpoints must give an identical answer regardless of any source label.
    const skill = { endpoints: [ep()] };
    for (const source of ["dom-fallback", "live-capture", "exa", "a-source-invented-tomorrow"]) {
      expect(carriesReplayableEndpoint({ ...skill, source } as never)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BARREN PERSISTENCE — the CLI is one process per call
// ─────────────────────────────────────────────────────────────────────────────

describe("PERMUTATION MATRIX — barren memory across processes", () => {
  // The guard was silently useless to the CLI before this existed: an
  // in-memory-only Map is always empty at startup, so a fresh process re-paid
  // the ~14s barren capture every single invocation. The measured 20x speedup
  // was real only inside one long-lived process (server / MCP shape).
  const T0 = 1_000_000;

  test("round-trips across a simulated process boundary", () => {
    _resetBarrenPages();
    markBarrenPage("list items", "https://x.test/p", T0);
    const wire = exportBarrenPages(T0 + 1_000);
    expect(wire.length).toBe(1);

    _resetBarrenPages();                                    // <- the new process
    expect(isBarrenPage("list items", "https://x.test/p", T0 + 1_000)).toBe(false);
    hydrateBarrenPages(wire, T0 + 1_000);
    expect(isBarrenPage("list items", "https://x.test/p", T0 + 1_000)).toBe(true);
  });

  test("an EXPIRED entry is never exported", () => {
    _resetBarrenPages();
    markBarrenPage("i", "https://x.test/p", T0);
    expect(exportBarrenPages(T0 + BARREN_PAGE_TTL_MS + 1)).toEqual([]);
  });

  test("an EXPIRED entry is never even STORED by hydrate", () => {
    _resetBarrenPages();
    hydrateBarrenPages([["i https://x.test/p", T0 - 1]], T0);
    // ORDER MATTERS. isBarrenPage DELETES an expired entry on read, so calling it
    // first erases the very evidence this assertion needs — which is why an
    // earlier version of this test survived a mutation that removed hydrate's TTL
    // check entirely. Inspect the stored set BEFORE any read touches it.
    expect(exportBarrenPages(T0 - 1_000)).toEqual([]);
    expect(isBarrenPage("i", "https://x.test/p", T0)).toBe(false);
  });

  test("malformed persisted rows are ignored rather than crashing a resolve", () => {
    _resetBarrenPages();
    const junk = [
      ["ok https://x.test/p", T0 + 60_000],
      [42, T0 + 60_000],
      ["missing-expiry", undefined],
      null,
    ] as unknown as Array<[string, number]>;
    expect(() => hydrateBarrenPages(junk, T0)).not.toThrow();
    expect(isBarrenPage("ok", "https://x.test/p", T0)).toBe(true);
  });

  test("hydrate is additive, never destructive to live in-process state", () => {
    _resetBarrenPages();
    markBarrenPage("a", "https://a.test/", T0);
    hydrateBarrenPages([["b https://b.test/", T0 + 60_000]], T0);
    expect(isBarrenPage("a", "https://a.test/", T0)).toBe(true);
    expect(isBarrenPage("b", "https://b.test/", T0)).toBe(true);
  });
});
