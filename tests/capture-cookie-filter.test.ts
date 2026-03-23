import { describe, expect, it } from "bun:test";
import { buildHeaderAuthForOrigin, filterCookiesForOriginHost, shouldUseHeaderAuthShim } from "../src/capture/index.js";

describe("filterCookiesForOriginHost", () => {
  it("keeps only cookies applicable to the page host", () => {
    const cookies = [
      { name: "root", value: "1", domain: ".x.com" },
      { name: "host", value: "1", domain: "x.com" },
      { name: "api", value: "1", domain: "api.x.com" },
      { name: "ads", value: "1", domain: "ads.x.com" },
    ];

    expect(filterCookiesForOriginHost(cookies, "https://x.com")).toEqual([
      { name: "root", value: "1", domain: ".x.com" },
      { name: "host", value: "1", domain: "x.com" },
    ]);
  });

  it("keeps subdomain cookies when the page host matches that subdomain", () => {
    const cookies = [
      { name: "root", value: "1", domain: ".x.com" },
      { name: "api", value: "1", domain: "api.x.com" },
    ];

    expect(filterCookiesForOriginHost(cookies, "https://api.x.com")).toEqual([
      { name: "root", value: "1", domain: ".x.com" },
      { name: "api", value: "1", domain: "api.x.com" },
    ]);
  });

  it("trims x.com cookie injection down to session-critical cookies", () => {
    const cookies = [
      { name: "lang", value: "1", domain: "x.com" },
      { name: "kdt", value: "1", domain: ".x.com" },
      { name: "auth_token", value: "1", domain: ".x.com" },
      { name: "ct0", value: "1", domain: ".x.com" },
      { name: "twid", value: "1", domain: ".x.com" },
      { name: "guest_id", value: "1", domain: ".x.com" },
      { name: "guest_id_ads", value: "1", domain: ".x.com" },
      { name: "guest_id_marketing", value: "1", domain: ".x.com" },
      { name: "personalization_id", value: "1", domain: ".x.com" },
      { name: "intercom-session", value: "1", domain: ".x.com" },
      { name: "_gcl_au", value: "1", domain: ".x.com" },
    ];

    expect(filterCookiesForOriginHost(cookies, "https://x.com/home")).toEqual([
      { name: "lang", value: "1", domain: "x.com" },
      { name: "kdt", value: "1", domain: ".x.com" },
      { name: "auth_token", value: "1", domain: ".x.com" },
      { name: "ct0", value: "1", domain: ".x.com" },
      { name: "twid", value: "1", domain: ".x.com" },
      { name: "guest_id", value: "1", domain: ".x.com" },
      { name: "guest_id_ads", value: "1", domain: ".x.com" },
      { name: "guest_id_marketing", value: "1", domain: ".x.com" },
      { name: "personalization_id", value: "1", domain: ".x.com" },
    ]);
  });

  it("uses header auth shim for x.com when session cookies are present", () => {
    const cookies = [
      { name: "auth_token", value: "\"auth\"", domain: ".x.com" },
      { name: "ct0", value: "\"csrf\"", domain: ".x.com" },
      { name: "twid", value: "u=1", domain: ".x.com" },
    ];

    expect(shouldUseHeaderAuthShim(cookies, "https://x.com/home")).toBe(true);
    expect(buildHeaderAuthForOrigin(cookies, "https://x.com/home")).toEqual({
      cookie: "auth_token=auth; ct0=csrf; twid=u=1",
      "x-csrf-token": "csrf",
    });
  });

  it("derives generic auth headers for non-x domains too", () => {
    const cookies = [
      { name: "li_at", value: "1", domain: ".linkedin.com" },
      { name: "JSESSIONID", value: "\"ajax:123\"", domain: ".linkedin.com" },
    ];

    expect(shouldUseHeaderAuthShim(cookies, "https://www.linkedin.com/feed/")).toBe(true);
    expect(buildHeaderAuthForOrigin(cookies, "https://www.linkedin.com/feed/")).toEqual({
      cookie: "li_at=1; JSESSIONID=ajax:123",
      "csrf-token": "ajax:123",
    });
  });
});
