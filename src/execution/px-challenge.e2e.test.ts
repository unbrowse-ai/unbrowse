/**
 * Plan-v13 Tier 2B — full integration E2E for solvePxAndRetry.
 *
 * Day 5 (Creatures) sub-agent A. Mirrors cf-challenge.e2e.test.ts.
 *
 * STATE: solvePxAndRetry is a STUB returning null (px-challenge.ts:64).
 * All 4 cases assert toBeNull() today. The inline comments mark which
 * assertions Step 6 (Dominion) must FLIP from `toBeNull()` to a
 * success-shape assertion when the solver is wired.
 *
 * Sandbox boundary mock is legitimate per CLAUDE.md "no mocks" carve-out:
 * runBundleReplay is a true external system (Kuri sandbox over HTTP),
 * mirroring the v14 e2e pattern.
 *
 * Run: bun test src/execution/px-challenge.e2e.test.ts
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";

// Synthetic PerimeterX interstitial fixture. The /uuid/uuid/init.js shape
// matches PX_BUNDLE_RE in px-challenge.ts.
const PX_APP_ID = "abcdef01-2345-6789-abcd-ef0123456789";
const PX_BODY = `<!DOCTYPE html>
<html>
<head><title>Access to this page has been denied</title></head>
<body>
  <div id="px-captcha"></div>
  <script src="/${PX_APP_ID}/${PX_APP_ID}/init.js"></script>
</body>
</html>`;

const PX_BODY_NO_BUNDLE = `<!DOCTYPE html>
<html>
<head><title>Access denied</title></head>
<body><div>blocked</div></body>
</html>`;

const TARGET_URL = "https://www.canadagoose.com/ca/en/parkas";
const EXPECTED_BUNDLE_URL =
  `https://www.canadagoose.com/${PX_APP_ID}/${PX_APP_ID}/init.js`;

const FAKE_BUNDLE_SOURCE = "/* fake px bundle */\n".repeat(120);

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
// Tier 2B integration tests
// ---------------------------------------------------------------------------

describe("solvePxAndRetry — plan-v13 Tier 2B integration E2E", () => {
  it("happy path: armed _pxhd + _px3 → retry returns content (FUTURE contract)", async () => {
    mock.module("../sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: async () => ({
        ok: true,
        ms: 42,
        egress_bytes: 0,
        cookies: [
          {
            name: "_pxhd",
            value: "armed-pxhd-token",
            domain: ".canadagoose.com",
            path: "/",
            expires: 0,
            secure: true,
            http_only: true,
            same_site: "None",
          },
          {
            name: "_px3",
            value: "armed-px3-token",
            domain: ".canadagoose.com",
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

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === EXPECTED_BUNDLE_URL) {
        return makeResponse(200, FAKE_BUNDLE_SOURCE, {
          "content-type": "application/javascript",
        });
      }
      if (url === TARGET_URL) {
        return makeResponse(200, '{"items":["parka"]}', {
          "content-type": "application/json",
        });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    }) as FetchImpl;

    const { solvePxAndRetry } = await import("./px-challenge.js");
    const result = await solvePxAndRetry({
      url: TARGET_URL,
      body: PX_BODY,
      cookies: [],
      kuriBase: undefined,
      proxy: undefined,
      timeoutMs: 15000,
    });

    // Step 6 (Dominion): solver is now real — assert success shape.
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.html).toContain("parka");
    expect(result!.cookies.some((c) => c.name === "_pxhd")).toBe(true);
    expect(result!.cookies.some((c) => c.name === "_px3")).toBe(true);
  });

  it("cookie gate: only _pxhd returned → null (single-cookie false-success guard)", async () => {
    // GATE TEST — protects against the _no_cookies_armed regression.
    // Plan-v13 L213: BOTH _pxhd AND _px3 are required, AND not OR.
    // If a future implementation accepts _pxhd alone, this test must FAIL.
    mock.module("../sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: async () => ({
        ok: true,
        ms: 42,
        egress_bytes: 0,
        cookies: [
          {
            name: "_pxhd",
            value: "only-pxhd",
            domain: ".canadagoose.com",
            path: "/",
            expires: 0,
            secure: true,
            http_only: true,
            same_site: "None",
          },
        ],
        routes_observed: [],
      }),
      cookiesToHeaderValue: () => "",
    }));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === EXPECTED_BUNDLE_URL) {
        return makeResponse(200, FAKE_BUNDLE_SOURCE, {
          "content-type": "application/javascript",
        });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    }) as FetchImpl;

    const { solvePxAndRetry } = await import("./px-challenge.js");
    const result = await solvePxAndRetry({
      url: TARGET_URL,
      body: PX_BODY,
      cookies: [],
      kuriBase: undefined,
      proxy: undefined,
      timeoutMs: 15000,
    });

    // Step 6: this assertion must REMAIN toBeNull() — both-cookies-required gate.
    expect(result).toBeNull();
  });

  it("cookie gate: only _px3 returned → null (symmetric pair to _pxhd-only)", async () => {
    // Symmetric pair to the previous case. Same gate, opposite missing cookie.
    mock.module("../sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: async () => ({
        ok: true,
        ms: 42,
        egress_bytes: 0,
        cookies: [
          {
            name: "_px3",
            value: "only-px3",
            domain: ".canadagoose.com",
            path: "/",
            expires: 0,
            secure: true,
            http_only: true,
            same_site: "None",
          },
        ],
        routes_observed: [],
      }),
      cookiesToHeaderValue: () => "",
    }));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === EXPECTED_BUNDLE_URL) {
        return makeResponse(200, FAKE_BUNDLE_SOURCE, {
          "content-type": "application/javascript",
        });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    }) as FetchImpl;

    const { solvePxAndRetry } = await import("./px-challenge.js");
    const result = await solvePxAndRetry({
      url: TARGET_URL,
      body: PX_BODY,
      cookies: [],
      kuriBase: undefined,
      proxy: undefined,
      timeoutMs: 15000,
    });

    // Step 6: this assertion must REMAIN toBeNull() — both-cookies-required gate.
    expect(result).toBeNull();
  });

  it("no bundle URL in body → short-circuit, runBundleReplay NOT invoked", async () => {
    // extractPxBundleUrl returns null when the body has no /uuid/uuid/init.js
    // tag. solver must short-circuit BEFORE calling the sandbox.
    const replaySpy = mock(async () => {
      throw new Error("runBundleReplay must NOT be called when bundle URL absent");
    });
    mock.module("../sandbox/bundle-replay-client.js", () => ({
      runBundleReplay: replaySpy,
      cookiesToHeaderValue: () => "",
    }));

    const fetchSpy = mock(async () => {
      throw new Error("fetch must NOT be called when bundle URL absent");
    });
    globalThis.fetch = fetchSpy as unknown as FetchImpl;

    const { solvePxAndRetry } = await import("./px-challenge.js");
    const result = await solvePxAndRetry({
      url: TARGET_URL,
      body: PX_BODY_NO_BUNDLE,
      cookies: [],
      kuriBase: undefined,
      proxy: undefined,
      timeoutMs: 15000,
    });

    expect(result).toBeNull();
    expect(replaySpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
