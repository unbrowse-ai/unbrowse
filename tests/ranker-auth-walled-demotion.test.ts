// Loop 4: ranker demotes auth_walled endpoints below data XHRs for
// content-read intents. Without this, x.com/home (score ~229 from URL
// exact-match against probe url) outscores HomeTimeline graphql XHRs
// (~-15) even though /home returns login-wall HTML for cold-cookie GETs.
//
// STRUCTURAL primitive: ANY content-read intent + ANY endpoint marked
// auth_walled at admission time -> demote by a fixed magnitude so any
// sibling non-auth-walled XHR in the same skill outranks it. No
// per-domain registry.

import { describe, expect, it } from "bun:test";
import { rankEndpoints } from "../src/execution/index.ts";
import type { EndpointDescriptor } from "../src/types/skill.ts";

function mkEp(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "e",
    method: "GET",
    url_template: "https://example.com/x",
    description: "",
    idempotency: "safe",
    verification_status: "unverified",
    reliability_score: 0.5,
    ...over,
  } as EndpointDescriptor;
}

describe("rankEndpoints: auth_walled demotion", () => {
  it("ranks a sibling XHR above an auth_walled SSR page for a content-read intent", () => {
    const eps: EndpointDescriptor[] = [
      mkEp({
        endpoint_id: "ssr-home",
        url_template: "https://x.com/home",
        description: "x.com home page",
        auth_walled: true,
      }),
      mkEp({
        endpoint_id: "xhr-home-timeline",
        url_template: "https://x.com/i/api/graphql/X/HomeTimeline",
        description: "HomeTimeline graphql query",
      }),
    ];
    const ranked = rankEndpoints(eps, "home timeline", "x.com", "https://x.com/home");
    expect(ranked[0].endpoint.endpoint_id).toBe("xhr-home-timeline");
  });

  it("does NOT apply the demotion when intent itself is auth-shaped (signal off, not flipped)", () => {
    const eps: EndpointDescriptor[] = [
      mkEp({
        endpoint_id: "ssr-login",
        url_template: "https://x.com/login",
        description: "x.com login page",
        auth_walled: true,
      }),
    ];
    // Score with non-auth-shaped intent (demotion ON)
    const nonAuthRanked = rankEndpoints(eps, "home timeline", "x.com", "https://x.com/login");
    // Score with auth-shaped intent (demotion OFF)
    const authRanked = rankEndpoints(eps, "sign in to x", "x.com", "https://x.com/login");
    // The auth-shaped intent must score the auth_walled endpoint at least
    // 350 higher than the non-auth-shaped intent (the demotion magnitude).
    expect(authRanked[0].score - nonAuthRanked[0].score).toBeGreaterThanOrEqual(350);
  });
  it("does NOT crash when no endpoint is auth_walled (backward-compat)", () => {
    const eps: EndpointDescriptor[] = [
      mkEp({ endpoint_id: "a", url_template: "https://x.com/feed", description: "" }),
      mkEp({ endpoint_id: "b", url_template: "https://x.com/api/data", description: "" }),
    ];
    const ranked = rankEndpoints(eps, "get feed", "x.com");
    expect(ranked.length).toBe(2);
    expect(ranked.map((r) => r.endpoint.endpoint_id).sort()).toEqual(["a", "b"]);
  });
});
