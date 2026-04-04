import { afterEach, describe, expect, it } from "bun:test";
import { assessInteractiveLoginState, loginWithBrowserFallback, shouldImportBrowserCookies } from "../src/auth/index.js";

const originalImportBrowserCookies = process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;

afterEach(() => {
  if (originalImportBrowserCookies === undefined) delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
  else process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = originalImportBrowserCookies;
});

describe("assessInteractiveLoginState", () => {
  it("keeps LinkedIn pending when only generic cookies exist", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://www.linkedin.com/feed/",
      targetDomain: "www.linkedin.com",
      initialCookieCount: 0,
      currentCookieCount: 2,
      currentCookies: [
        { name: "JSESSIONID", domain: ".linkedin.com", secure: true, httpOnly: true },
        { name: "bcookie", domain: ".linkedin.com", secure: true, httpOnly: false },
      ],
    });

    expect(result).toEqual({ status: "pending", reason: "non_auth_cookies_only" });
  });

  it("marks LinkedIn authenticated when li_at is present on the target page", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://www.linkedin.com/feed/",
      targetDomain: "www.linkedin.com",
      initialCookieCount: 0,
      currentCookieCount: 3,
      currentCookies: [
        { name: "li_at", domain: ".linkedin.com", secure: true, httpOnly: true },
        { name: "JSESSIONID", domain: ".linkedin.com", secure: true, httpOnly: true },
      ],
    });

    expect(result).toEqual({ status: "authenticated", reason: "auth_cookies_present_on_target" });
  });

  it("marks Cloudflare challenge as blocked", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://x.com/home",
      targetDomain: "x.com",
      initialCookieCount: 1,
      currentCookieCount: 2,
      hasCloudflareChallenge: true,
    });

    expect(result).toEqual({ status: "blocked", reason: "cloudflare_challenge" });
  });

  it("keeps login pages pending", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://www.linkedin.com/login",
      targetDomain: "www.linkedin.com",
      initialCookieCount: 0,
      currentCookieCount: 1,
      currentCookies: [
        { name: "li_at", domain: ".linkedin.com", secure: true, httpOnly: true },
      ],
    });

    expect(result).toEqual({ status: "pending", reason: "still_on_login_path" });
  });
});

describe("shouldImportBrowserCookies", () => {
  it("defaults to enabled", () => {
    delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    expect(shouldImportBrowserCookies()).toBe(true);
  });

  it("respects explicit opt-out values", () => {
    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "false";
    expect(shouldImportBrowserCookies()).toBe(false);
  });
});

describe("loginWithBrowserFallback", () => {
  it("returns browser-cookie auth when keychain import succeeds", async () => {
    let interactiveCalled = false;

    const result = await loginWithBrowserFallback(
      "https://www.linkedin.com/feed/",
      { browser: "chrome" },
      {
        extractBrowserAuth: async () => ({ success: true, domain: "www.linkedin.com", cookies_stored: 4 }),
        interactiveLogin: async () => {
          interactiveCalled = true;
          return { success: true, domain: "www.linkedin.com", cookies_stored: 1 };
        },
      },
    );

    expect(result).toEqual({ success: true, domain: "www.linkedin.com", cookies_stored: 4 });
    expect(interactiveCalled).toBe(false);
  });

  it("falls back to interactive login when browser-cookie import has nothing reusable", async () => {
    let interactiveCalled = false;

    const result = await loginWithBrowserFallback(
      "https://www.linkedin.com/feed/",
      { browser: "chrome" },
      {
        extractBrowserAuth: async () => ({
          success: false,
          domain: "www.linkedin.com",
          cookies_stored: 0,
          error: "No cookies found in any browser",
        }),
        interactiveLogin: async () => {
          interactiveCalled = true;
          return { success: true, domain: "www.linkedin.com", cookies_stored: 2 };
        },
      },
    );

    expect(result).toEqual({ success: true, domain: "www.linkedin.com", cookies_stored: 2 });
    expect(interactiveCalled).toBe(true);
  });
});
