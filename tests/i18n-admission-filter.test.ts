// Falsifiable signal for the I18N admission filter in extractEndpoints
// (src/reverse-engineer/index.ts:isApiLike).
//
// Asserts that translation/locale endpoints — which return valid JSON and
// would otherwise survive body_not_json_or_html — are rejected at extraction
// admission, never published into the skill manifest.
//
// Real failure: similarweb.com/website/openai.com/ captured 183 XHRs but
// only the i18n translation file survived extraction; bench picked it,
// execute returned HTTP 404 stale_endpoint. Root cause: i18n was admitted.

import { describe, it, expect } from "bun:test";
import { extractEndpoints } from "../backend/src/services/reverse-engineer/index";
import type { RawRequest } from "../src/types/skill";

function req(url: string, body = '{"k":"v"}'): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: [],
    response_status: 200,
    response_headers: [["content-type", "application/json"]],
    response_body: body,
  } as RawRequest;
}

describe("extractEndpoints i18n admission filter", () => {
  const ctx = { pageUrl: "https://www.similarweb.com/website/openai.com/", finalUrl: "https://www.similarweb.com/website/openai.com/" };

  it("rejects /i18n/ paths even when they return valid JSON", () => {
    const eps = extractEndpoints([
      req("https://gro.similarweb.com/i18n/similarweb_gaconnect/production/en-us/translation", '{"hello":"world"}'),
    ], undefined, ctx);
    expect(eps.length).toBe(0);
  });

  it("rejects /locales/ paths", () => {
    const eps = extractEndpoints([
      req("https://example.com/locales/en-US.json", '{"greeting":"hi"}'),
    ], undefined, ctx);
    expect(eps.length).toBe(0);
  });

  it("rejects /translations/ paths", () => {
    const eps = extractEndpoints([
      req("https://example.com/translations/v2/en/strings", '{"k":"v"}'),
    ], undefined, ctx);
    expect(eps.length).toBe(0);
  });

  it("rejects /lang/<code>/ paths", () => {
    const eps = extractEndpoints([
      req("https://example.com/lang/en/strings.json", '{"a":"b"}'),
    ], undefined, ctx);
    expect(eps.length).toBe(0);
  });

  it("does not over-filter — /api/ paths still admitted", () => {
    const eps = extractEndpoints([
      req("https://www.similarweb.com/api/website-overview/openai.com", '{"traffic":1000000,"rank":42}'),
    ], { pageUrl: "https://www.similarweb.com/website/openai.com/", finalUrl: "https://www.similarweb.com/website/openai.com/" });
    expect(eps.length).toBeGreaterThan(0);
  });
});
