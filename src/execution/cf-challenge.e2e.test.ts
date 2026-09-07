/**
 * Plan-v13 Tier 2A — full integration E2E for solveCfAndRetry.
 *
 * Day 6 (Dominion) sub-agent 3/8. Written in parallel with sub-agents 1 + 2,
 * targeting the EXPECTED post-state of cf-challenge.ts:
 *   - imports `runBundleReplay` from "../sandbox/bundle-replay-client.js"
 *   - bundle-fetch via globalThis.fetch
 *   - runBundleReplay returns cf_clearance
 *   - retry via globalThis.fetch
 *
 * NOTE on mocking: cf-challenge.ts does NOT currently import runBundleReplay
 * (the in-file call is unbound until sub-agent 1 lands). We use bun's
 * `mock.module` to stub the bundle-replay-client export so the call resolves.
 * If sub-agent 1 hasn't landed yet, the bare `runBundleReplay` reference
 * inside cf-challenge.ts is a runtime ReferenceError and the tests will fail
 * with that signature — that's the correct failure mode (NOT faking green).
 *
 * Run: bun test src/execution/cf-challenge.e2e.test.ts
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";

// Synthetic Cloudflare interstitial fixture.
const CF_FIXTURE_BODY = `<!DOCTYPE html>
<html lang="en-US">
<head>
  <title>Just a moment...</title>
  <meta http-equiv="refresh" content="390">
</head>
<body class="no-js">
  <div class="main-wrapper" role="main">
    <div class="main-content">
      <noscript>
        <div id="challenge-error-title">Enable JavaScript and cookies to continue</div>
      </noscript>
    </div>
  </div>
  <script>
    window._cf_chl_opt = {
      cvId: '3',
      cType: 'managed',
      cNounce: '12345',
      cRay: '8a1b2c3d4e5f6789',
      cHash: 'abc123def456',
    };
    document.cookie = "__cf_chl_rt_tk=fake; path=/";
  </script>
  <script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc123def456/main.js"></script>
</body>
</html>`;

const TARGET_URL = "https://www.indeed.com/jobs?q=software";
const EXPECTED_BUNDLE_URL =
  "https://www.indeed.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc123def456/main.js";

// Roughly 2KB of fake bundle text (must clear the >= 1024 length gate).
const FAKE_BUNDLE_SOURCE = "/* fake cf bundle */\n".repeat(120);

// ---------------------------------------------------------------------------
// fetch stubbing
// ---------------------------------------------------------------------------

type FetchImpl = typeof globalThis.fetch;
let originalFetch: FetchImpl;

function makeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tier 2A integration tests
// ---------------------------------------------------------------------------

describe("solveCfAndRetry — plan-v13 Tier 2A integration E2E", () => {
  it("solves a synthetic CF challenge and returns final HTML + cf_clearance", async () => {
    // Stub the sandbox runBundleReplay to return a clearance cookie.
    mock.module("../sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: async () => ({
        ok: true,
        ms: 42,
        egress_bytes: 0,
        cookies: [
          {
            name: "cf_clearance",
            value: "synthetic-clearance-token-xyz",
            domain: ".indeed.com",
            path: "/",
            expires: 0,
            secure: true,
            http_only: true,
            same_site: "None",
          },
        ],
        routes_observed: [],
      }),
      cookiesToHeaderValue: (cookies: Array<{ name: string; value: string }>) =>
        cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    }));

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url === EXPECTED_BUNDLE_URL) {
        return makeResponse(200, FAKE_BUNDLE_SOURCE, {
          "content-type": "application/javascript",
        });
      }
      if (url === TARGET_URL) {
        return makeResponse(200, '{"items":["ok"]}', {
          "content-type": "application/json",
        });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    }) as FetchImpl;

    const { solveCfAndRetry } = await import("./cf-challenge.js");
    const result = await solveCfAndRetry({
      url: TARGET_URL,
      body: CF_FIXTURE_BODY,
      cookies: [],
      kuriBase: undefined,
      proxy: undefined,
      timeoutMs: 15000,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.html).toContain("ok");
    expect(result!.cookies.some((c) => c.name === "cf_clearance")).toBe(true);
    // Bundle fetch first, retry second.
    expect(calls[0]).toBe(EXPECTED_BUNDLE_URL);
    expect(calls[1]).toBe(TARGET_URL);
  });

  it("returns null when the bundle fetch 404s", async () => {
    mock.module("../sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: async () => {
        throw new Error("should not be called when bundle fetch fails");
      },
      cookiesToHeaderValue: () => "",
    }));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === EXPECTED_BUNDLE_URL) {
        return makeResponse(404, "not found");
      }
      throw new Error(`unexpected fetch call: ${url}`);
    }) as FetchImpl;

    const { solveCfAndRetry } = await import("./cf-challenge.js");
    const result = await solveCfAndRetry({
      url: TARGET_URL,
      body: CF_FIXTURE_BODY,
      cookies: [],
      kuriBase: undefined,
      proxy: undefined,
      timeoutMs: 15000,
    });

    expect(result).toBeNull();
  });
});
