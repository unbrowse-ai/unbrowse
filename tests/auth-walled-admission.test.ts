// Loop 4 (post B-023 platform): admission-time auth-walled detection.
//
// Every captured endpoint whose response body looks like a login-wall page
// must carry that signal forward so the ranker can demote it below sibling
// data XHRs. Without this, x.com/home (SSR LoggedOutShell HTML) outscores
// HomeTimeline graphql XHRs at the top of the shortlist, and the gate's
// deterministic top-pick ships /home which 401s.
//
// STRUCTURAL primitive, not per-domain. Detection runs on response body
// shape (HTML + login keywords) regardless of host.

import { describe, expect, it } from "bun:test";
import { extractEndpoints, type RawRequest } from "../src/reverse-engineer/index.ts";

const HTML_LOGIN_WALL = `<!doctype html><html><head><title>Sign in to X / X</title></head><body><div>LoggedOutShell</div></body></html>`;
const HTML_REAL_DATA = `<!doctype html><html><head><title>Home / X</title></head><body><main>Real feed content here</main></body></html>`;
const JSON_DATA = `{"data":{"home":{"timeline":{"entries":[]}}}}`;

function mkReq(overrides: Partial<RawRequest>): RawRequest {
  return {
    method: "GET",
    url: "https://example.com/page",
    request_headers: {},
    response_headers: { "content-type": "text/html" },
    response_status: 200,
    response_body: HTML_LOGIN_WALL,
    ...overrides,
  } as RawRequest;
}

describe("admission: auth_walled signal", () => {
  it("sets auth_walled=true on an HTML response whose title contains login keywords", () => {
    const reqs = [mkReq({ url: "https://x.com/home", response_body: HTML_LOGIN_WALL })];
    const eps = extractEndpoints(reqs);
    const ep = eps.find((e) => e.url_template?.includes("/home"));
    expect(ep).toBeDefined();
    expect(ep!.auth_walled).toBe(true);
  });

  it("does NOT set auth_walled when the HTML response has no login keywords", () => {
    const reqs = [mkReq({ url: "https://x.com/home", response_body: HTML_REAL_DATA })];
    const eps = extractEndpoints(reqs);
    const ep = eps.find((e) => e.url_template?.includes("/home"));
    if (ep) expect(ep.auth_walled).toBeFalsy();
  });

  it("does NOT set auth_walled on JSON responses (the ranker decides, not admission)", () => {
    const reqs = [mkReq({
      url: "https://x.com/i/api/graphql/X/HomeTimeline",
      response_headers: { "content-type": "application/json" },
      response_body: JSON_DATA,
    })];
    const eps = extractEndpoints(reqs);
    const ep = eps.find((e) => e.url_template?.includes("HomeTimeline"));
    if (ep) expect(ep.auth_walled).toBeFalsy();
  });

  it("works generically across hosts (not per-domain)", () => {
    for (const host of ["reddit.com", "linkedin.com", "github.com", "notion.so"]) {
      const reqs = [mkReq({
        url: `https://${host}/feed`,
        response_body: `<html><head><title>Log in - ${host}</title></head></html>`,
      })];
      const eps = extractEndpoints(reqs);
      const ep = eps.find((e) => e.url_template?.includes("/feed"));
      expect(ep?.auth_walled, `host=${host}`).toBe(true);
    }
  });
});
