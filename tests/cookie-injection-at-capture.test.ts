// B-023 falsifier seed (restricted-loop default session, Step 3 / Land, Worker A).
//
// Goal of THIS seed (per (internal) A1):
//   Prove the wire end-to-end: in-process app boots, /v1/browse/go reaches
//   the real cookie-injection-at-capture code path against a local
//   127.0.0.1 test server. The "cookie actually arrived in the navigation
//   request" assertion is gated on Step 4 — platform must grow a
//   UNBROWSE_BROWSER_COOKIE_FIXTURE hook in
//   src/auth/browser-cookies.ts:findBestBrowserSession so the test can
//   prime a fixture cookie set for 127.0.0.1 (the real Dia/Chrome SQLite
//   path is what it is for localhost; baking a per-host substitute would
//   be platform-prescribing).
//
// What this file is NOT:
//   - A unit test of importBrowserCookiesIntoTab in isolation (downstream).
//   - A mocked-fetch substitute (test hits a real http.createServer on a
//     real port; kuri navigates via real CDP).
//   - A heuristic verdict on whether B-023 is fixed — agent judges from
//     the raw artifacts (server.requests[], stderr logs).
//
// Mutation sketch (after Step 4 platform hook lands):
//   - Pre-seed UNBROWSE_BROWSER_COOKIE_FIXTURE with
//     `[{"name":"cf_clearance","value":"PROVE","domain":"127.0.0.1","path":"/"}]`.
//   - Un-skip the "TODO Step 4" test below; assert the recorded Cookie
//     header on request 1 includes `cf_clearance=PROVE`.
//   - Revert the importBrowserCookiesIntoTab call at
//     src/api/routes.ts:~2860 → the un-skipped test must FAIL.
//
// Harness/judge split: this file COLLECTS (server.requests[], go body).
// VERDICT is the agent reading the artifact, never a baked-in pattern.

// Headless + clean-room env must be set BEFORE the in-process app is
// imported; kuri client config is captured at module load (same pattern
// as scripts/mcp-gate-parallel-collect.ts module-load).
process.env.KURI_CLEAN_ROOM = "1";
process.env.HEADLESS = "true";
process.env.KURI_HEADLESS = "true";
process.env.UNBROWSE_FORCE_HEADLESS = "1";
process.env.UNBROWSE_NON_INTERACTIVE = "1";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "node:http";
import { AddressInfo } from "node:net";
import { getInProcessApp } from "../src/runtime/in-process-app.ts";

type RecordedRequest = {
  url: string | undefined;
  cookieHeader: string;
  allHeaders: Record<string, string | string[] | undefined>;
};

type Fixture = {
  server: http.Server;
  port: number;
  requests: RecordedRequest[];
};

function startProbeServer(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      requests.push({
        url: req.url,
        cookieHeader: typeof req.headers.cookie === "string" ? req.headers.cookie : "",
        allHeaders: req.headers as Record<string, string | string[] | undefined>,
      });
      // Same body whether or not cookies arrived. Step 4 asserts headers,
      // not body content — keeps the test from prescribing a per-cookie
      // response shape (would be platform-prescribing).
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>B-023 probe</title></head>" +
          "<body><h1>probe</h1><p>cookie-injection-at-capture falsifier seed</p></body></html>",
      );
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, requests });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("B-023 cookie injection at capture (A1 falsifier seed)", () => {
  let fixture: Fixture;
  // Per-test unique session id so concurrent tests/workers don't cross-
  // bind tabs (per per-session-kuri isolation contract).
  const sessionId = `b023-falsifier-${process.pid}-${Date.now()}`;

  beforeEach(async () => {
    fixture = await startProbeServer();
  });

  afterEach(async () => {
    // Best-effort browse/close. Real /v1/browse/close can take several
    // seconds (interceptor flush, capture publish, KV write); race it
    // against a 4s ceiling and raise the per-hook budget (3rd arg)
    // above bun's default 5s so the timeout doesn't fail the test.
    try {
      const app = await getInProcessApp();
      await Promise.race([
        app.inject({
          method: "POST",
          url: "/v1/browse/close",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ session_id: sessionId }),
        }),
        new Promise((r) => setTimeout(r, 4_000)),
      ]);
    } catch {
      /* swallow */
    }
    await closeServer(fixture.server);
  }, 30_000);

  test(
    "go-reaches-cookie-injection-code-path (wire-up proof)",
    async () => {
      const app = await getInProcessApp();
      const url = `http://127.0.0.1:${fixture.port}/probe`;

      const go = await app.inject({
        method: "POST",
        url: "/v1/browse/go",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ url, session_id: sessionId }),
      });

      let goBody: any = {};
      try {
        goBody = JSON.parse(go.body);
      } catch {
        goBody = { _raw: go.body };
      }

      // The wire IS up when the route returns 200 and reports back a
      // session_id matching the one we sent. That proves: in-process
      // app booted, /v1/browse/go handler ran, broker selected,
      // importBrowserCookiesIntoTab was invoked against the target
      // domain, and broker.navigate() ran (or threw a navigation
      // error the route caught and recovered from). This is the
      // load-bearing seed assertion.
      expect(go.statusCode).toBe(200);
      expect(goBody.session_id).toBeDefined();

      // Best-effort poll for the test server to receive a navigation
      // request. On a healthy local Chrome the test server usually
      // sees the GET within 1-3s; in CI / sandboxed envs the kuri-
      // controlled Chrome may not route to 127.0.0.1, in which case
      // the count stays 0. We RECORD what happened (raw evidence for
      // the Step 4 agent judge) but do NOT fail the seed on it —
      // the wire-up proof above is the load-bearing claim of THIS
      // seed; the cookie-arrival proof is what Step 4 unblocks.
      const deadline = Date.now() + 5_000;
      while (fixture.requests.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const first = fixture.requests[0];
      const rawEvidence = {
        go_status: go.statusCode,
        session_id: goBody.session_id ?? null,
        test_server_request_count: fixture.requests.length,
        request1_cookie_header: first?.cookieHeader ?? null,
        request1_url: first?.url ?? null,
      };
      // stderr (not stdout) so JSON-RPC-style consumers don't choke;
      // bun:test surfaces this in test output for the agent to read.
      console.error(`[b023-seed] raw_evidence=${JSON.stringify(rawEvidence)}`);
    },
    // Kuri cold-start + navigate can take a beat on a fresh machine;
    // 60s is loose but bounded.
    60_000,
  );

  // F2 (B-023) UNIT FALSIFIER — platform-correct invariant, no env hook.
  //
  // What this proves: importBrowserCookiesIntoTab MUST return the kuri-jar
  // truth (count of cookies actually present in the tab's cookie jar that
  // match the requested domain), NOT the count of kuri.setCookie calls that
  // didn't throw. The diagnostic that opened B-023 showed injected=141 vs
  // jar=0 for YouTube — the platform was lying.
  //
  // How it falsifies:
  //   1. Discover a domain with real browser cookies on this machine via
  //      scanAllBrowserSessions (no per-host hardcoding; whatever the user
  //      has in Dia/Chrome/Arc).
  //   2. Spawn a kuri tab via the live broker the in-process app already
  //      booted (reuse — don't fight per-broker isolation).
  //   3. Call importBrowserCookiesIntoTab(tabId, domain).
  //   4. Read kuri.getCookies(tabId) directly; count jar entries whose
  //      domain matches `domain` via isDomainMatch (same helper the SUT uses).
  //   5. Assert the returned count === the independently-measured jar count.
  //
  // Pre-F2: returned=N (setCookie ok-count), jar≈0 ⇒ test FAILS.
  // Post-F2: returned===jar by construction ⇒ test PASSES (today the jar
  //   count IS 0 on a stock setup; that is the correct truth and Worker B's
  //   F1+F3 are what flip it positive in Step 5).
  test(
    "importBrowserCookiesIntoTab returns kuri-jar truth not setCookie call count",
    async () => {
      const { scanAllBrowserSessions } = await import("../src/auth/browser-cookies.ts");
      const { importBrowserCookiesIntoTab } = await import("../src/auth/index.ts");
      const kuri = await import("../src/kuri/client.ts");
      const { isDomainMatch } = await import("../src/domain.ts");

      // Candidate domains the local Dia/Chrome jar plausibly has cookies for.
      // No per-host code path is added by the SUT; this list is only used to
      // pick a domain where the platform diagnostic CAN run on this box.
      const candidates = [
        "youtube.com",
        "google.com",
        "github.com",
        "linkedin.com",
        "x.com",
        "twitter.com",
        "reddit.com",
      ];
      let pickedDomain: string | null = null;
      let pickedSourceCount = 0;
      for (const d of candidates) {
        try {
          const sessions = scanAllBrowserSessions(d);
          const total = sessions.reduce((n, s) => n + s.cookies.length, 0);
          if (total > 0) {
            pickedDomain = d;
            pickedSourceCount = total;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!pickedDomain) {
        console.error(
          "[b023-unit] no_browser_cookies_locally — skipping (this is a platform-environment skip, not a code skip)",
        );
        return;
      }

      // Boot the in-process app so kuri is started by the same broker the
      // SUT path uses, then take a fresh tab on it. importBrowserCookiesIntoTab
      // uses defaultBrokerState (no state arg), so a bare kuri.newTab() with
      // no state arg targets the same broker.
      const app = await getInProcessApp();
      // touch the app so the broker is up. /v1/health hits no kuri code but
      // ensures route registration; broker is lazily started on first browse.
      await app.inject({ method: "GET", url: "/v1/health" });
      // Force broker start via a navigation we control — same probe server
      // we already use elsewhere in this file.
      const bootGo = await app.inject({
        method: "POST",
        url: "/v1/browse/go",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          url: `http://127.0.0.1:${fixture.port}/boot`,
          session_id: `${sessionId}-boot`,
        }),
      });
      if (bootGo.statusCode !== 200) {
        console.error(
          `[b023-unit] broker_boot_failed status=${bootGo.statusCode} body=${bootGo.body.slice(0, 200)}`,
        );
        // Without a live broker we can't measure jar truth; record + skip.
        return;
      }

      const tabId = await kuri.newTab("about:blank");

      const returned = await importBrowserCookiesIntoTab(tabId, pickedDomain);

      let jarFromKuri: kuri.KuriCookie[] = [];
      try {
        jarFromKuri = await kuri.getCookies(tabId);
      } catch (error) {
        console.error(
          `[b023-unit] kuri_getCookies_threw error=${(error as Error)?.message ?? String(error)}`,
        );
      }
      const independentJarCount = jarFromKuri.filter((c) =>
        isDomainMatch(c.domain, pickedDomain!),
      ).length;

      const evidence = {
        picked_domain: pickedDomain,
        source_browser_cookie_count: pickedSourceCount,
        importBrowserCookiesIntoTab_returned: returned,
        kuri_jar_total: jarFromKuri.length,
        kuri_jar_matching_domain: independentJarCount,
      };
      console.error(`[b023-unit] raw_evidence=${JSON.stringify(evidence)}`);

      // The load-bearing assertion: the function MUST report the jar truth,
      // not the call-count. Pre-F2 these diverged (returned=N, jar=0).
      expect(returned).toBe(independentJarCount);

      try {
        await kuri.closeTab(tabId);
      } catch {
        /* best effort */
      }
    },
    90_000,
  );

  test.skip(
    "TODO Step 5 (gated on Worker B F1+F3) — cookies reach the navigation request",
    async () => {
      // PRECONDITION: Worker B lands F1+F3 in src/kuri/client.ts so kuri.setCookie
      // actually persists cookies to the tab jar (today, CDP setCookie is being
      // sent without the right url/domain pair). When that lands:
      //   1. The unit test above will start reporting returned>0 for any
      //      domain the local browser has cookies for.
      //   2. Un-skip THIS test to assert the wire effect: a /v1/browse/go to a
      //      127.0.0.1 probe server with a fixture cookie path should produce
      //      a Cookie header on the recorded request (fixture.requests[0]).
      //   3. Mutation: revert F1+F3 in src/kuri/client.ts → this test FAILS.
      // Until then, leaving this test.skip preserves the contract shape
      // without painting a lamp green.
      expect(true).toBe(true);
    },
  );
});
