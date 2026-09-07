// Falsifier for the kuri.evaluate "[object Object]" 15-byte garbage bug.
//
// MCP gate run 20260518T115632Z showed probe 001 (Hacker News) with
// `dom_html_size: 15` in capture_diagnostic — exactly the byte-length of
// the string `"[object Object]"`. The collector's eval response was
// `{"result":{"error":"CDP command failed"}}`. The product side
// (src/api/browse-index.ts cacheBrowseRequests) called
// `kuri.getPageHtml(tabId)` which internally calls
// `kuri.evaluate(tabId, "document.documentElement.outerHTML")`.
//
// Inside `evaluate` at src/kuri/client.ts:1086-1087, the path
// `const inner = raw?.result?.result; if (!inner) return raw;` silently
// returns the raw error envelope when CDP didn't produce a normal
// `{ result: { result: { type, value } } }` shape. `getPageHtml` then
// does `String(result ?? "")` which coerces the error object to the
// literal string `"[object Object]"` — 15 characters of garbage that
// then passes the `livePageHtmlSize > 0` check and (subtly) fails the
// `html.trimStart().startsWith("<")` check, so the DOM-fallback path
// thinks it has SOME html and goes through tryHttpFetch anyway. The
// diagnostic field dom_html_size=15 is the breadcrumb.
//
// This file imports the real `evaluate` from kuri/client.ts and feeds
// it the real CDP error shapes via a stub `kuriGet` override. No real
// kuri broker is launched — we are testing the TypeScript wrapper's
// error handling, which is the layer that bakes "[object Object]".
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as kuriClient from "../src/kuri/client.ts";

// We hijack `kuriGet` by replacing the in-module fetch through a global
// override. The cleanest way: re-import the module after setting an env
// var that the kuri client reads. But the wrapper's transport indirects
// through `fetch` at the bottom of `kuriGet`. We can monkey-patch
// global.fetch for this test.

const REAL_FETCH = globalThis.fetch;

function stubFetchWith(jsonBody: unknown) {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(jsonBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  // ensure each test starts with the real fetch unless explicitly stubbed
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("kuri.evaluate — CDP error-envelope handling (gate run 20260518T115632Z)", () => {
  it("HAPPY PATH: normal CDP success returns inner.value verbatim", async () => {
    stubFetchWith({
      id: 0,
      result: { result: { type: "string", value: "<html><body>hi</body></html>" } },
    });
    const r = await kuriClient.evaluate("tab-1", "document.documentElement.outerHTML");
    expect(r).toBe("<html><body>hi</body></html>");
  });

  it("CDP returned an error envelope (no result.result) — must NOT coerce to '[object Object]'", async () => {
    // This is the actual shape the gate-run collector captured:
    // {"result":{"error":"CDP command failed"}, "session_id":"...", "tab_id":"..."}
    stubFetchWith({
      id: 0,
      result: { error: "CDP command failed" },
    });
    const r = await kuriClient.evaluate("tab-1", "document.documentElement.outerHTML");
    // The contract: when CDP didn't produce a usable value, evaluate must
    // return undefined (or an empty string) — anything that does NOT
    // coerce to the deceptive 15-byte "[object Object]" string when
    // downstream callers do `String(r ?? "")`.
    expect(String(r ?? "")).not.toBe("[object Object]");
    // Downstream `getPageHtml` does `String(result ?? "")`. After the
    // fix this must be the empty string so the !html guard in
    // browse-index fires honestly.
    expect(String(r ?? "")).toBe("");
  });

  it("CDP exceptionDetails (JS error thrown in page) must surface, not coerce silently", async () => {
    stubFetchWith({
      id: 0,
      result: {
        result: undefined,
        exceptionDetails: {
          text: "Uncaught ReferenceError: foo is not defined",
          lineNumber: 1,
        },
      },
    });
    const r = await kuriClient.evaluate("tab-1", "foo()");
    // Must not silently coerce to "[object Object]". Either undefined
    // or a string carrying the exception is acceptable; "[object Object]"
    // is the painted-lamp shape that hid this bug.
    expect(String(r ?? "")).not.toBe("[object Object]");
  });

  it("getPageHtml: composed call returns '' instead of '[object Object]' on CDP error", async () => {
    stubFetchWith({
      id: 0,
      result: { error: "CDP command failed" },
    });
    const html = await kuriClient.getPageHtml("tab-1");
    expect(html).not.toBe("[object Object]");
    expect(html.length).not.toBe(15);
    // Downstream check in src/api/browse-index.ts L355:
    //   if (!html || !html.trimStart().startsWith("<")) { ... fallback }
    // An empty string triggers the same fallback path as garbage HTML
    // but with an HONEST signal (dom_html_size=0, not 15).
    expect(html).toBe("");
  });

  it("undefined CDP result (type='undefined') stays undefined, not coerced", async () => {
    stubFetchWith({
      id: 0,
      result: { result: { type: "undefined" } },
    });
    const r = await kuriClient.evaluate("tab-1", "void 0");
    expect(r).toBe(undefined);
  });
});
