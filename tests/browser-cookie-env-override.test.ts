import { describe, expect, it } from "bun:test";
import { browserCookieOptionsFromEnv, resolveChromiumCookiesPath } from "../src/auth/browser-cookies.js";

describe("explicit Chromium cookie source (#133)", () => {
  it("maps a non-default user-data-dir and profile from env", () => {
    const opts = browserCookieOptionsFromEnv(undefined, {
      UNBROWSE_CHROME_USER_DATA_DIR: "/tmp/chrome-agent",
      UNBROWSE_CHROME_PROFILE: "Default",
    });
    expect(opts).toMatchObject({
      browser: "chromium",
      chromium: { userDataDir: "/tmp/chrome-agent", profile: "Default" },
    });
    expect(resolveChromiumCookiesPath(opts?.chromium)).toBe("/tmp/chrome-agent/Default/Cookies");
  });

  it("supports the direct cookie DB override", () => {
    const opts = browserCookieOptionsFromEnv(undefined, { UNBROWSE_COOKIE_DB_PATH: "/tmp/Cookies" });
    expect(resolveChromiumCookiesPath(opts?.chromium)).toBe("/tmp/Cookies");
  });

  it("leaves explicit call options unchanged when no env override exists", () => {
    const original = { browser: "firefox" as const, firefoxProfile: "work" };
    expect(browserCookieOptionsFromEnv(original, {})).toBe(original);
  });
});
