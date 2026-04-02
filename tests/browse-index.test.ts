import { describe, expect, it } from "bun:test";
import { buildBrowseRequestKey, mergeBrowseRequests } from "../src/api/browse-index.js";
import type { RawRequest } from "../src/capture/index.js";
import type { KuriHarEntry } from "../src/kuri/client.js";

describe("browse request merge", () => {
  it("includes request body in the dedupe key for repeated POSTs", () => {
    const first: RawRequest = {
      url: "https://example.com/api",
      method: "POST",
      request_headers: {},
      request_body: "{\"date\":\"2026-04-04\"}",
      response_headers: {},
      response_status: 200,
      timestamp: new Date().toISOString(),
    };
    const second: RawRequest = {
      ...first,
      request_body: "{\"date\":\"2026-04-05\"}",
    };

    expect(buildBrowseRequestKey(first)).not.toBe(buildBrowseRequestKey(second));
  });

  it("merges intercepted and har requests without collapsing distinct bodies", () => {
    const intercepted: RawRequest[] = [{
      url: "https://example.com/api",
      method: "POST",
      request_headers: {},
      request_body: "{\"slot\":\"7:45pm\"}",
      response_headers: {},
      response_status: 200,
      timestamp: new Date().toISOString(),
    }];

    const harEntries: KuriHarEntry[] = [{
      request: {
        method: "POST",
        url: "https://example.com/api",
        headers: [],
        postData: { text: "{\"slot\":\"8:15pm\"}" },
      },
      response: {
        status: 200,
        headers: [],
        content: { text: "{}" },
      },
      startedDateTime: new Date().toISOString(),
    }];

    const merged = mergeBrowseRequests(intercepted, harEntries);
    expect(merged).toHaveLength(2);
  });

  it("normalizes relative intercepted and har urls against the session url", () => {
    const intercepted: RawRequest[] = [{
      url: "/api/cart",
      method: "POST",
      request_headers: {},
      request_body: "{\"slot\":\"7:45pm\"}",
      response_headers: {},
      response_status: 200,
      timestamp: new Date().toISOString(),
    }];

    const harEntries: KuriHarEntry[] = [{
      request: {
        method: "POST",
        url: "/cdn-cgi/rum?",
        headers: [],
      },
      response: {
        status: 204,
        headers: [],
        content: { text: "" },
      },
      startedDateTime: new Date().toISOString(),
    }];

    const merged = mergeBrowseRequests(intercepted, harEntries, "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html");
    expect(merged.map((request) => request.url)).toEqual([
      "https://www.mandai.com/api/cart",
      "https://www.mandai.com/cdn-cgi/rum?",
    ]);
  });
});
