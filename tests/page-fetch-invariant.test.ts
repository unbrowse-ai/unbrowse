// Falsifiable signals for the page_fetch invariant introduced in
// .bench-history/ROOT_FIX_GUIDE.md (2026-05-08).
//
// Invariant: every captured skill carries a `page_fetch` endpoint as
// the always-callable bedrock floor. Without this, SSR-rendered pages
// (Amazon search, Bing search, etc.) return empty shortlist or only
// telemetry endpoints — the agent has nothing to call.
//
// These tests guard the shape of `buildPageFetchEndpoint` + the
// `isPageFetchEndpoint` type-guard. The "agent calls the endpoint and
// gets real HTML" signal lives in scripts/bench-two-phase.sh against
// the live corpus.

import { describe, expect, it } from "bun:test";
import {
  buildPageFetchEndpoint,
  isPageFetchEndpoint,
} from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

describe("buildPageFetchEndpoint", () => {
  it("emits an EndpointDescriptor with method=GET and templated url", () => {
    const ep = buildPageFetchEndpoint(
      "https://www.amazon.com/s?k=usb+c+cable",
      "get amazon search",
    );
    expect(ep.method).toBe("GET");
    expect(ep.url_template).toContain("amazon.com/s");
    expect(ep.url_template).toContain("{k}");  // query param templated
    expect(ep.query).toEqual({ k: "usb c cable" });
    expect(ep.semantic?.example_request).toEqual({ k: "usb c cable" });
    expect(ep.idempotency).toBe("safe");
    expect(ep.verification_status).toBe("verified");
  });

  it("marks dom_extraction.extraction_method == 'page_fetch'", () => {
    const ep = buildPageFetchEndpoint("https://example.com/", "test");
    expect(ep.dom_extraction).toBeDefined();
    expect(ep.dom_extraction!.extraction_method).toBe("page_fetch");
  });

  it("sets confidence to 0.5 (above 0.2 quality floor, below /api/ scores)", () => {
    const ep = buildPageFetchEndpoint("https://example.com/", "test");
    expect(ep.dom_extraction!.confidence).toBe(0.5);
  });

  it("describes itself for the intent so agents recognize the endpoint", () => {
    const ep = buildPageFetchEndpoint("https://hn.com/", "get top stories");
    expect(ep.description).toContain("get top stories");
    expect(ep.description).toContain("hn.com");
  });

  it("flags auth_required only when authRequired=true", () => {
    const noAuth = buildPageFetchEndpoint("https://example.com/", "test", false);
    const withAuth = buildPageFetchEndpoint("https://example.com/", "test", true);
    expect(noAuth.semantic?.auth_required).toBeFalsy();
    expect(withAuth.semantic?.auth_required).toBe(true);
  });

  it("yields a stable endpoint_id (idempotent across calls with same inputs)", () => {
    const a = buildPageFetchEndpoint("https://example.com/x?q=1", "test");
    const b = buildPageFetchEndpoint("https://example.com/x?q=2", "test");
    // Same templated URL → same endpoint_id (query values templated away).
    expect(a.endpoint_id).toBe(b.endpoint_id);
  });

  it("distinguishes from page_artifact endpoints by extraction_method", () => {
    const pageFetch = buildPageFetchEndpoint("https://example.com/", "test");
    const fakeArtifact: EndpointDescriptor = {
      endpoint_id: "fake",
      method: "GET",
      url_template: "https://example.com/",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      description: "page artifact",
      dom_extraction: {
        extraction_method: "repeated-elements",
        confidence: 0.9,
      },
    };
    expect(isPageFetchEndpoint(pageFetch)).toBe(true);
    expect(isPageFetchEndpoint(fakeArtifact)).toBe(false);
  });
});

describe("isPageFetchEndpoint", () => {
  it("returns false for endpoints without dom_extraction", () => {
    const xhr: EndpointDescriptor = {
      endpoint_id: "xhr",
      method: "GET",
      url_template: "https://api.example.com/v1/data",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      description: "xhr",
    };
    expect(isPageFetchEndpoint(xhr)).toBe(false);
  });

  it("returns false for dom_extraction with a different method", () => {
    const ep: EndpointDescriptor = {
      endpoint_id: "rep",
      method: "GET",
      url_template: "https://example.com/",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      description: "rep-elements artifact",
      dom_extraction: {
        extraction_method: "repeated-elements",
        confidence: 0.9,
      },
    };
    expect(isPageFetchEndpoint(ep)).toBe(false);
  });

  it("LOST SHEEP: a page_fetch endpoint round-trips through JSON.parse(JSON.stringify(...))", () => {
    // Catches a bug class where serialization (capture writes JSON, resolve
    // reads JSON) accidentally drops dom_extraction or its extraction_method.
    // Without this guard a future serialization regression silently breaks
    // the type-guard for every published skill.
    const ep = buildPageFetchEndpoint("https://example.com/", "test");
    const roundtripped = JSON.parse(JSON.stringify(ep));
    expect(isPageFetchEndpoint(roundtripped)).toBe(true);
  });
});
