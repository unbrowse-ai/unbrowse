/**
 * A bot wall is not the endpoint's answer.
 *
 * Measured on defillama.com, both engines, same page, same intent:
 *
 *   GET /api/public/protocol-rankings?chain=All&sort=tvl&order=desc&limit=75
 *     cdp     -> 200  application/json  301,918 bytes
 *     obscura -> 403  text/html           6,930 bytes
 *                server: cloudflare, cf-ray present, cf-mitigated: challenge,
 *                <title>Just a moment...</title>
 *
 * The route was never missing — it was refused. But `apiLikelyRequests` admits
 * on URL SHAPE (`/api/…`) and never reads the status, so that interstitial was
 * admitted as an api-like request and was about to become the evidence, and the
 * response contract, for a real endpoint. A fabricated contract is precisely
 * what the capture invariants exist to prevent.
 *
 * Two properties are asserted, and the second matters as much as the first:
 *   1. a challenge row never becomes a route
 *   2. it is REPORTED, not dropped — "exists and was refused" is a different
 *      fact from "no such route", and only one of them is worth escalating
 */
import { describe, expect, test } from "bun:test";
import { partitionBlockedRequests } from "../src/capture/obscura-capture.js";
import { classifyExecuteFailure } from "../src/values/blocker-classification.js";
import type { RawRequest } from "../src/capture/index.js";

const row = (over: Partial<RawRequest>): RawRequest => ({
  url: "https://defillama.com/api/public/protocol-rankings?chain=All&sort=tvl&limit=75",
  method: "GET",
  request_headers: {},
  response_status: 200,
  response_headers: { "content-type": "application/json" },
  response_body: '{"protocols":[{"name":"Lido","tvl":1}]}',
  timestamp: new Date(0).toISOString(),
  ...over,
});

/** What Cloudflare actually returned, headers and body head verbatim. */
const CF_CHALLENGE = row({
  response_status: 403,
  response_headers: {
    "content-type": "text/html; charset=UTF-8",
    server: "cloudflare",
    "cf-ray": "9a1f0c2d3e4f5678-LHR",
    "cf-mitigated": "challenge",
  },
  response_body:
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>'
    + '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">'
    + '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head></html>',
});

describe("a refused route never becomes a route", () => {
  test("the Cloudflare interstitial is partitioned out", () => {
    const { ok, blocked } = partitionBlockedRequests([CF_CHALLENGE]);
    expect(ok).toEqual([]);
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.vendor).toBe("cloudflare");
  });

  test("it is reported with its URL — refused is not the same as absent", () => {
    // If this row were merely dropped, the caller would see the same empty
    // result as a page with no API at all, and would "fix" the wrong thing.
    const { blocked } = partitionBlockedRequests([CF_CHALLENGE]);
    expect(blocked[0]!.request.url).toContain("/api/public/protocol-rankings");
    expect(blocked[0]!.evidence).toBeTruthy();
  });

  test("the origin's REAL answer is untouched", () => {
    const real = row({});
    const { ok, blocked } = partitionBlockedRequests([real]);
    expect({ ok: ok.length, blocked: blocked.length }).toEqual({ ok: 1, blocked: 0 });
    expect(ok[0]!.response_body).toContain("Lido");
  });

  test("a mixed capture keeps exactly the real rows", () => {
    const { ok, blocked } = partitionBlockedRequests([
      row({}),
      CF_CHALLENGE,
      row({ url: "https://defillama.com/api/public/yields", response_body: '{"data":[]}' }),
    ]);
    expect({ ok: ok.length, blocked: blocked.length }).toEqual({ ok: 2, blocked: 1 });
    expect(ok.every((r) => r.response_status === 200)).toBe(true);
  });
});

describe("a mention of a wall is not a wall — the false positive I shipped and caught", () => {
  test("a 200 JS bundle that REFERENCES the challenge script is kept", () => {
    // Measured, not imagined: this exact row was classified vendor_blocked and
    // dropped from the routes, because classifyExecuteFailure matches vendor
    // markers anywhere in the body. Over-blocking silently deletes captured
    // endpoints, which is the worse direction of the two.
    const bundle = row({
      url: "https://defillama.com/_next/static/chunks/0d4tjgmdsm3dl.js",
      response_status: 200,
      response_headers: { "content-type": "application/javascript" },
      response_body: 'fetch("/cdn-cgi/challenge-platform/scripts/jsd/main.js");// turnstile',
    });
    const { ok, blocked } = partitionBlockedRequests([bundle]);
    expect({ ok: ok.length, blocked: blocked.length }).toEqual({ ok: 1, blocked: 0 });
  });

  test("a 200 JSON payload mentioning a vendor is kept", () => {
    const { blocked } = partitionBlockedRequests([
      row({ response_body: JSON.stringify({ items: [{ note: "we use cloudflare turnstile" }] }) }),
    ]);
    expect(blocked).toEqual([]);
  });

  test("but a 200 text/html interstitial IS still caught — status alone is not the test", () => {
    // Cloudflare serves challenges with 200 as well as 403, so a status-only
    // gate would miss them.
    const soft = row({
      response_status: 200,
      response_headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
      response_body: "<html><head><title>Just a moment...</title></head></html>",
    });
    const { ok, blocked } = partitionBlockedRequests([soft]);
    expect({ ok: ok.length, blocked: blocked.length }).toEqual({ ok: 0, blocked: 1 });
  });
});

describe("ORDER: partition must precede dedup — the regression I shipped and a subagent caught", () => {
  // captureAndIndexViaObscura dedups by `${method} ${path}`, FIRST WINS. My first
  // version partitioned AFTER that dedup, so an endpoint seen once as a challenge
  // and again as a successful retry lost its good row to the dedup and then lost
  // its challenge row to the partition — the endpoint vanished. "Refused" became
  // "absent", the exact confusion the partition exists to prevent.
  //
  // This models the real pipeline order rather than reaching into it, so it stays
  // true if the seam moves.
  const path = (u: string) => new URL(u).pathname;
  const pipeline = (rows: RawRequest[], partitionFirst: boolean) => {
    const dedupe = (rs: RawRequest[]) => {
      const m = new Map<string, RawRequest>();
      for (const r of rs) { const k = `${r.method} ${path(r.url)}`; if (!m.has(k)) m.set(k, r); }
      return [...m.values()];
    };
    if (partitionFirst) {
      const { ok } = partitionBlockedRequests(rows);
      return dedupe(ok);
    }
    const { ok } = partitionBlockedRequests(dedupe(rows));
    return ok;
  };

  // Same endpoint: challenged first, then answered for real on retry.
  const CHALLENGED_THEN_OK: RawRequest[] = [
    CF_CHALLENGE,
    row({ response_body: '{"protocols":[{"name":"Lido","tvl":1}]}' }),
  ];

  test("partition-then-dedup KEEPS the successful retry", () => {
    const routes = pipeline(CHALLENGED_THEN_OK, true);
    expect(routes.length).toBe(1);
    expect(routes[0]!.response_status).toBe(200);
  });

  test("dedup-then-partition LOSES the endpoint entirely — the shipped bug", () => {
    // Asserting the broken behaviour on purpose: it is what makes the fix's
    // value legible, and it fails loudly if someone reorders the seam back.
    expect(pipeline(CHALLENGED_THEN_OK, false)).toEqual([]);
  });

  test("an endpoint that answered is not ALSO reported as refused", () => {
    const { ok } = partitionBlockedRequests(CHALLENGED_THEN_OK);
    const answered = new Set(ok.map((r) => `${r.method} ${path(r.url)}`));
    const { blocked } = partitionBlockedRequests(CHALLENGED_THEN_OK);
    const reported = blocked.filter((b) => !answered.has(`${b.request.method} ${path(b.request.url)}`));
    // Sending a caller to escalate something they already have is its own lie.
    expect(reported).toEqual([]);
  });
});

describe("recognition is delegated, so a new vendor costs nothing here", () => {
  test("other vendors are caught by the SAME classifier, with no new branch", () => {
    // The point of routing through classifyExecuteFailure instead of writing a
    // Cloudflare check next to the capture path: these pass without this file
    // knowing anything about them.
    const vendors = [
      { marker: "datadome", body: '<html>datadome captcha</html>', hdr: { "x-datadome": "protected" } },
      { marker: "perimeterx", body: '<html>{"appId":"px"}</html>', hdr: {} },
      { marker: "akamai_bot_manager", body: '<html>reference #_abck bot-defender</html>', hdr: {} },
    ];
    for (const v of vendors) {
      const c = classifyExecuteFailure({
        status: 403,
        body: v.body,
        headers: { "content-type": "text/html", ...v.hdr },
      });
      expect({ marker: v.marker, kind: c.kind }).toEqual({ marker: v.marker, kind: "vendor_blocked" });
    }
  });

  test("a 200 JSON collection is never mistaken for a wall", () => {
    const { blocked } = partitionBlockedRequests([
      row({ response_body: JSON.stringify({ items: [{ id: 1 }], note: "access granted" }) }),
    ]);
    expect(blocked).toEqual([]);
  });
});
