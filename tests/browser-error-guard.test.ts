/**
 * browser-error-guard.test — the cache-poisoning fix. A capture that died because egress failed
 * (Chrome's "No Internet" / ERR_PROXY_CONNECTION_FAILED page) must NOT pass the quality gate, or
 * its error-page schema gets cached as a "skill" and poisons resolve. Regression: the exact
 * spa-initial-state payload the agent-driven bench found cached as a stackoverflow endpoint.
 */
import { describe, expect, it } from "bun:test";
import { looksLikeBrowserError, looksBlocked } from "../src/capture/fetch-ladder.js";

// The exact poisoned payload from the bench (stackoverflow capture through a dead proxy).
const PROXY_ERROR_JSON = JSON.stringify({
  details: "Details", errorCode: "ERR_PROXY_CONNECTION_FAILED",
  heading: { msg: "No Internet" }, isOfflineError: false, iconClass: "icon-generic",
  summary: { msg: "There is something wrong with the proxy server or the address is incorrect." },
  title: "stackoverflow.com",
});

describe("looksLikeBrowserError", () => {
  it("flags the proxy-failure / No-Internet error page", () => {
    expect(looksLikeBrowserError(PROXY_ERROR_JSON)).toBe(true);
    expect(looksLikeBrowserError("net::ERR_NAME_NOT_RESOLVED")).toBe(true);
    expect(looksLikeBrowserError("This site can’t be reached")).toBe(true);
    expect(looksLikeBrowserError("chrome-error://chromewebdata/")).toBe(true);
  });
  it("does NOT flag real content", () => {
    expect(looksLikeBrowserError('{"questions":[{"title":"How to sort a list in Python"}]}')).toBe(false);
    expect(looksLikeBrowserError("Newest Questions - Stack Overflow")).toBe(false);
    expect(looksLikeBrowserError(null)).toBe(false);
  });
});

describe("looksBlocked folds in the browser-error guard", () => {
  it("treats a browser error page as blocked (even when large)", () => {
    const padded = PROXY_ERROR_JSON + " ".repeat(2000); // > minBytes, still must be blocked
    expect(looksBlocked(padded)).toBe(true);
  });
  it("still passes real content of sufficient size", () => {
    const real = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, title: `q${i}` })) });
    expect(looksBlocked(real)).toBe(false);
  });
});
