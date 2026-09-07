import { describe, it, expect } from "bun:test";
import {
  deriveIntentHints,
  computeWantedHints,
  matchInterceptedToHint,
} from "../src/capture/index.js";

// Pins issue #98 (SPA network-idle: wait for lazy-loaded API calls).
// waitForContentReady Phase 4 polls intercepted requests for an API
// matching the intent hints; the recognition decision is the pure
// computeWantedHints + matchInterceptedToHint pair extracted from that
// loop. No mocks, no kuri: this falsifier proves a lazy/late-arriving
// API that matches a wanted hint IS recognized, and that an
// already-satisfied hint is not re-waited on. If this regresses, SPA
// lazy-load capture silently breaks again.

describe("#98 lazy-API wait: computeWantedHints", () => {
  it("drops a hint already satisfied by a captured URL, keeps the rest", () => {
    const derived = new Set(["tweet", "timeline", "status"]);
    const captured = ["https://x.com/i/api/2/timeline/home.json"]; // satisfies "timeline"
    expect(computeWantedHints(derived, captured)).toEqual(["tweet", "status"]);
  });

  it("keeps every hint when nothing is captured yet (initial load)", () => {
    expect(computeWantedHints(["profile", "users"], [])).toEqual(["profile", "users"]);
  });

  it("matches captured URLs case-insensitively (mirrors u.toLowerCase())", () => {
    // hint 'graphql' satisfied even though the captured URL is upper-cased
    expect(computeWantedHints(["graphql", "feed"], ["https://API.X.COM/GraphQL/Abc"]))
      .toEqual(["feed"]);
  });

  it("accepts any iterable for captured urls (Map.keys() at the call site)", () => {
    const bodies = new Map<string, string>([["https://h/api/users/1", "{}"]]);
    expect(computeWantedHints(["users", "company"], bodies.keys())).toEqual(["company"]);
  });
});

describe("#98 lazy-API wait: matchInterceptedToHint (the late-arrival recognition)", () => {
  const wanted = ["tweet", "status"];

  it("recognizes a LATE/lazy API that arrives after initial load", () => {
    // This is the #98 core: the call was not present at readyState; it
    // shows up later in the interceptor poll and must be matched.
    expect(matchInterceptedToHint("https://x.com/i/api/graphql/abc/UserTweets", wanted))
      .toBe("tweet");
  });

  it("returns null for a non-data request (no wanted hint present)", () => {
    expect(matchInterceptedToHint("https://x.com/sw.js", wanted)).toBeNull();
    expect(matchInterceptedToHint("https://x.com/static/main.css", wanted)).toBeNull();
  });

  it("matches case-insensitively on the request URL", () => {
    expect(matchInterceptedToHint("https://X.COM/I/API/STATUS/123", wanted)).toBe("status");
  });

  it("returns the FIRST wanted hint (deterministic, order-stable)", () => {
    expect(matchInterceptedToHint("https://h/tweet/status/1", ["tweet", "status"])).toBe("tweet");
  });

  it("empty wanted set never matches", () => {
    expect(matchInterceptedToHint("https://h/api/anything", [])).toBeNull();
  });
});

describe("#98 end-to-end recognition (deriveIntentHints -> wanted -> match)", () => {
  it("a lazy timeline API is recognized for intent 'get tweets'", () => {
    const derived = deriveIntentHints("https://x.com/elonmusk", "get tweets");
    expect(derived).toContain("timeline");
    // nothing captured at readyState
    const wanted = computeWantedHints(derived, []);
    // the timeline XHR fires lazily after scroll/hydration
    const late = "https://x.com/i/api/graphql/xyz/UserTimeline?variables=...";
    const hit = matchInterceptedToHint(late, wanted);
    expect(hit).not.toBeNull();
    expect(["timeline", "tweet", "status"]).toContain(hit);
  });

  it("does not re-wait once the matching API was already captured", () => {
    const derived = deriveIntentHints("https://x.com/elonmusk", "get tweets");
    const already = ["https://x.com/i/api/graphql/xyz/UserTweets"]; // contains 'tweet'
    const wanted = computeWantedHints(derived, already);
    expect(wanted).not.toContain("tweet");
  });
});
