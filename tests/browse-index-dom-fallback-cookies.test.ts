/**
 * BUG-1 regression: cacheBrowseRequests' DOM-fallback path now passes
 * the live tab's cookies to tryHttpFetch.
 *
 * Background: when a page renders successfully in Kuri but the live tab's
 * getPageHtml returns malformed HTML (Kuri's CDP eval can serialize
 * document.documentElement to "[object Object]" when its response shape
 * changes — CLAUDE.md), the DOM-fallback path falls back to a plain
 * server-fetch via tryHttpFetch.
 *
 * Before this fix tryHttpFetch was called with empty cookies. On
 * Cloudflare-gated sites like npmjs.com/package/openai or
 * hub.docker.com, the raw fetch hits the "Just a moment..." challenge
 * and returns ~5KB of garbage. extractFromDOM downgrades to
 * html_metadata_fallback at confidence 0.4, validateExtractionQuality
 * rejects it at the 0.5 floor, and the whole close() reports
 * indexed:false / endpoint_count:0 even though the live tab is
 * showing the real page.
 *
 * The fix: when cacheBrowseRequests is given a getCookies() callback,
 * the DOM-fallback path collects the live tab's cookies and passes
 * them through to tryHttpFetch, so CF clearance the live session
 * earned carries into the server-fetch. Without getCookies the
 * fallback behaves exactly as before (empty cookies).
 *
 * Surfaced by the 2026-05-17 MCP bench-gate run on #002 (npm package
 * openai) and #010 (hub.docker.com nginx tags). No mocks: the real
 * cacheBrowseRequests function is invoked with a real local HTTP
 * server playing CF-gate vs unlocked-html based on whether the
 * cookie was forwarded.
 */

import { test, expect, afterEach } from "bun:test";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { cacheBrowseRequests } from "../src/api/browse-index.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

function startTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  });
}

/** Mimic the Cloudflare "Just a moment..." gate: tiny challenge page when
 *  the request has no CF clearance cookie, real SSR page when it does. */
function startCfGatedServer(realHtml: string, clearanceCookie: string): Promise<{ baseUrl: string }> {
  return startTestServer((req, res) => {
    const cookies = req.headers["cookie"] ?? "";
    const hasClearance = typeof cookies === "string" && cookies.includes(clearanceCookie);
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (hasClearance) {
      res.end(realHtml);
    } else {
      // ~5KB CF challenge stub. extractFromDOM gives this at most
      // html_metadata_fallback confidence 0.4 (below the 0.5 gate).
      const padding = "<!-- " + "x".repeat(5000) + " -->";
      res.end(`<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><h1>Verify you are human</h1>${padding}</body></html>`);
    }
  });
}

test("BUG-1: DOM-fallback uses session cookies so CF-gated tryHttpFetch returns real HTML", async () => {
  // Real-shape SSR HTML for a hypothetical "get package info" intent.
  // The extractor's key-value path should accept this at high
  // confidence. Padded to > 1024 bytes because tryHttpFetch rejects
  // bodies smaller than that as obviously-truncated.
  const realHtml = `<!DOCTYPE html>
<html lang="en-US">
<head>
  <meta charset="utf-8">
  <title>openai - npm</title>
  <meta name="description" content="The official TypeScript library for the OpenAI API. Latest version 6.38.0, last published 2 days ago.">
  <meta property="og:title" content="openai">
  <meta property="og:description" content="The official TypeScript library for the OpenAI API">
  <link rel="canonical" href="http://npmjs.example/package/openai">
</head>
<body>
  <main>
    <h1>openai</h1>
    <p>The official TypeScript library for the OpenAI API. Latest version 6.38.0, last published 2 days ago. Start using openai in your project by running 'npm i openai'.</p>
    <dl>
      <dt>Latest version</dt><dd>6.38.0</dd>
      <dt>License</dt><dd>Apache-2.0</dd>
      <dt>Unpacked size</dt><dd>3.4 MB</dd>
      <dt>Total Files</dt><dd>274</dd>
      <dt>Last publish</dt><dd>2 days ago</dd>
      <dt>Collaborators</dt><dd>openai-bot</dd>
      <dt>Issues</dt><dd>0</dd>
      <dt>Pull Requests</dt><dd>0</dd>
      <dt>Weekly downloads</dt><dd>10,221,447</dd>
    </dl>
    <section>
      <h2>Readme</h2>
      <p>The OpenAI TypeScript and JavaScript API library provides convenient access to the OpenAI REST API from server-side TypeScript or JavaScript. The library includes type definitions for all request params and response fields, and offers both synchronous and asynchronous clients powered by fetch.</p>
    </section>
  </main>
</body>
</html>`;

  const { baseUrl } = await startCfGatedServer(realHtml, "cf_clearance=abc123");
  const sessionUrl = `${baseUrl}/package/openai`;

  // The live tab simulates the known-bug: getPageHtml returns malformed
  // output ("[object Object]"), forcing the DOM-fallback to server-fetch.
  // getCookies returns the live tab's CF clearance cookie. The server
  // honors that and returns the real HTML, so extraction passes the gate
  // and the page indexes mode:"dom" with a real endpoint.
  const result = await cacheBrowseRequests({
    sessionUrl,
    sessionDomain: "127.0.0.1",
    requests: [], // pure SSR, no XHRs
    getPageHtml: async () => "[object Object]",
    getCookies: async () => [
      { name: "cf_clearance", value: "abc123", domain: "127.0.0.1" },
    ],
    intent: "get package info openai",
  });

  expect(result.indexed).toBe(true);
  expect(result.mode).toBe("dom");
  expect(result.skill).not.toBeNull();
  expect(result.skill?.endpoints.length).toBeGreaterThan(0);
});

// (deleted: "BUG-1 mutation: without getCookies, CF-gated fallback still fails")
//
// This mutation test was pinning the pre-PR#500 admission gate which
// rejected DOM-fallbacks under confidence 0.5. PR#500 removed the gate
// by design — agent + usage signal now decide quality via the
// reliability_score feedback loop. The "without getCookies = indexed
// false" mutation no longer falsifies anything: every non-null capture
// admits. Keeping the test as `indexed=false` was actively wrong;
// rewriting it to `indexed=true with neutral reliability` is moot
// because reliability_score is a usage-time signal, not a publish-time
// constant (dag-feedback boosts it 0.05 per success). The happy-path
// test above + the non-fatal-error test below already pin every

test("BUG-1: getCookies failure is non-fatal (substrate doesn't throw, falls back to empty cookies)", async () => {
  const realHtml = `<!DOCTYPE html>
<html><head><title>openai - npm</title><meta name="description" content="The official TypeScript library for the OpenAI API."></head>
<body><main><h1>openai</h1><dl><dt>Latest version</dt><dd>6.38.0</dd><dt>License</dt><dd>Apache-2.0</dd><dt>Weekly downloads</dt><dd>10221447</dd></dl></main></body></html>`;
  const { baseUrl } = await startCfGatedServer(realHtml, "cf_clearance=abc123");
  const sessionUrl = `${baseUrl}/package/openai`;

  // Whatever happens here — admitted or rejected — the substrate must
  // not throw. This is the ONLY behavioural claim this test makes;
  // indexed-value assertions belong in the dedicated admission tests
  // above. (Pre-#500 this also asserted indexed===false; that was
  // pinning the heuristic admission gate which has since been
  // removed by design.)
  const result = await cacheBrowseRequests({
    sessionUrl,
    sessionDomain: "127.0.0.1",
    requests: [],
    getPageHtml: async () => "[object Object]",
    getCookies: async () => { throw new Error("simulated cookie store error"); },
    intent: "get package info openai",
  });

  expect(result).toBeTruthy();
  expect(typeof result.indexed).toBe("boolean");
});
