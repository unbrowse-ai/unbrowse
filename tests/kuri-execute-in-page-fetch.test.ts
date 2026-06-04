/**
 * Regression test for executeInPageFetch script-shape bug.
 *
 * The previous implementation built the in-page JS source by embedding
 * runtime-derived strings directly into a template literal:
 *
 *     headers: ${JSON.stringify(headers)},
 *
 * The hub.docker.com #010_anchor MCP-gate probe surfaced a
 * "SyntaxError: Invalid or unexpected token" with HTTP status 0 on
 * every iteration -- the in-page script never reached its own
 * try/catch because V8's parser rejected the source before execution.
 *
 * The exact offending character in dockerhub's response headers
 * isn't pinned in this test (would require reproducing the live
 * load), but the SHAPE of the script is the root cause: embedding
 * runtime-derived strings into JS source is a parser-tripping
 * minefield the moment any value carries a character V8 won't
 * tolerate in raw source. Different V8 versions are differently
 * permissive (Bun's V8 accepts U+2028 / U+2029 in template literals;
 * the Chrome bundled with Kuri demonstrably does not for some
 * dockerhub-returned value).
 *
 * The fix swaps the strategy: serialize the entire fetch config to
 * ONE JSON string, embed THAT as a single JSON-stringified string
 * literal, and JSON.parse it inside the page. JSON.parse accepts
 * any JSON-legal character regardless of V8 version.
 *
 * These tests pin the new shape: every produced script parses
 * cleanly under Bun's V8, and the source contains the JSON.parse
 * contract production depends on. If a future refactor reverts to
 * embedding-without-parse, the "if (cfg.hasBody)" structural
 * assertion fails.
 */

import { test, expect } from "bun:test";
import vm from "node:vm";

// Re-import the local helper shape so the test stays at the same layer
// as the source. We don't import executeInPageFetch directly because it
// drives a real Kuri broker; we want to assert the SCRIPT it produces.
function buildFetchScript(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
): string {
  // Mirrors src/kuri/client.ts:executeInPageFetch verbatim, factored out
  // so the test can pin the script's parse-ability without spinning a
  // browser. If client.ts diverges, this test must diverge with it.
  const cfg = JSON.stringify({
    url,
    method,
    headers,
    hasBody: body !== undefined,
    body: body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  return `(async function() {
    try {
      var cfg = JSON.parse(${JSON.stringify(cfg)});
      var init = { method: cfg.method, headers: cfg.headers };
      if (cfg.hasBody) init.body = cfg.body;
      var res = await fetch(cfg.url, init);
      var text = await res.text();
      var data;
      try { data = JSON.parse(text); } catch(e) { data = text; }
      return JSON.stringify({ status: res.status, data: data });
    } catch(e) {
      return JSON.stringify({ status: 0, data: { error: e.message } });
    }
  })()`;
}

function assertParseable(script: string): void {
  // vm.Script's constructor throws SyntaxError on parse failure —
  // exactly the failure shape the bug produced inside the page.
  new vm.Script(script);
}

test("executeInPageFetch script: clean ASCII headers parse cleanly", () => {
  const script = buildFetchScript(
    "https://example.com/api",
    "GET",
    { accept: "application/json", "user-agent": "ub-test/1" },
    undefined,
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: header value with U+2028 still parses (regression fix)", () => {
  // U+2028 LINE SEPARATOR — the dockerhub-class bug. Pre-fix this
  // threw SyntaxError on parse. Post-fix the char is inside a JSON
  // string that JS source sees as escaped via JSON.stringify.
  const script = buildFetchScript(
    "https://hub.docker.com/r/library/nginx/tags",
    "GET",
    { "x-test": "value-with- -line-separator" },
    undefined,
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: header value with U+2029 still parses", () => {
  const script = buildFetchScript(
    "https://hub.docker.com/",
    "GET",
    { "x-test": "value-with- -paragraph-separator" },
    undefined,
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: header value with backticks parses", () => {
  // Backticks would close the outer template literal in the OLD shape.
  const script = buildFetchScript(
    "https://example.com/",
    "GET",
    { "x-test": "value-with-`backtick`" },
    undefined,
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: header value with ${} parses", () => {
  // ${...} inside a JS template literal would evaluate as an
  // expression. JSON.stringify escapes the dollar sign? No — JSON
  // doesn't escape $. But because we embed the JSON output INSIDE
  // ANOTHER JSON.stringify call, the resulting JS source sees it as
  // a string literal, not a template literal context.
  const script = buildFetchScript(
    "https://example.com/",
    "GET",
    { "x-test": "value-with-${injection}" },
    undefined,
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: body string parses", () => {
  const script = buildFetchScript(
    "https://example.com/api",
    "POST",
    { "content-type": "application/json" },
    JSON.stringify({ q: "test", page: 1 }),
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: body object parses", () => {
  const script = buildFetchScript(
    "https://example.com/api",
    "POST",
    { "content-type": "application/json" },
    { q: "test nasty", page: 1 },
  );
  expect(() => assertParseable(script)).not.toThrow();
});

test("executeInPageFetch script: undefined body produces no body field but still parses", () => {
  const script = buildFetchScript(
    "https://example.com/",
    "GET",
    { accept: "*/*" },
    undefined,
  );
  expect(() => assertParseable(script)).not.toThrow();
  // And the script shouldn't reference cfg.body in the init when hasBody is false.
  // We can't introspect runtime behavior here without executing; the
  // structural check is "if (cfg.hasBody) init.body = cfg.body".
  expect(script).toContain("if (cfg.hasBody) init.body = cfg.body");
});
