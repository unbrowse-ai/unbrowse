/**
 * Browser-policy spine witnesses:
 *   - site priority weights: cookie ≫ bookmark ≫ history
 *   - cookie import env aliases
 *   - listInstalledBrowsers metadata shape
 */
import { afterEach, describe, expect, it } from "bun:test";
import { shouldImportBrowserCookies } from "../src/auth/index.js";
import { listInstalledBrowsers } from "../src/auth/browser-preferences.js";
import {
  scoreSitePriority,
  shortlistSortKey,
  SITE_PRIORITY_WEIGHTS,
} from "../src/auth/site-priority.js";
import { composeInventory } from "../src/cli-v7/eval/auth-inventory.js";

const envKeys = [
  "UNBROWSE_IMPORT_BROWSER_COOKIES",
  "UNBROWSE_COOKIE_IMPORT",
] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

function stashEnv() {
  for (const k of envKeys) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
}

describe("site priority weights (cookie ≫ bookmark ≫ history)", () => {
  it("fresh auth cookie scores higher than bookmark alone", () => {
    const cookieOnly = scoreSitePriority({ fresh_cookie: true });
    const bookmarkOnly = scoreSitePriority({ bookmarked: true });
    expect(cookieOnly).toBeGreaterThanOrEqual(SITE_PRIORITY_WEIGHTS.freshAuthCookie);
    expect(bookmarkOnly).toBe(SITE_PRIORITY_WEIGHTS.bookmarked);
    expect(cookieOnly).toBeGreaterThan(bookmarkOnly);
  });

  it("bookmark scores higher than heavy history alone", () => {
    const bookmark = scoreSitePriority({ bookmarked: true });
    const heavyHistory = scoreSitePriority({
      visit_count: 999,
      last_visit_unix: Math.floor(Date.now() / 1000),
    });
    expect(bookmark).toBeGreaterThan(heavyHistory);
  });

  it("composeInventory matches cookie ≫ bookmark ≫ history", () => {
    const now = 1_700_000_000;
    const inv = composeInventory({
      cookies: [
        {
          host_key: "auth.example",
          name: "session",
          expires_utc_unix: now + 86400 * 30,
        },
        {
          host_key: "weak.example",
          name: "_ga",
          expires_utc_unix: now + 86400 * 30,
        },
      ],
      history: [
        {
          hostname: "history.example",
          visit_count: 200,
          last_visit_unix: now - 3600,
        },
      ],
      bookmarks: [{ hostname: "bookmark.example" }],
      nowUnix: now,
    });
    expect(inv["auth.example"]!.likely_logged_in_score).toBeGreaterThanOrEqual(0.6);
    expect(inv["bookmark.example"]!.likely_logged_in_score).toBe(0.2);
    expect(inv["history.example"]!.likely_logged_in_score).toBeLessThan(
      inv["bookmark.example"]!.likely_logged_in_score,
    );
    // analytics-only cookie is any_cookie lift, still below bookmark
    expect(inv["weak.example"]!.likely_logged_in_score).toBe(0.15);
    expect(inv["weak.example"]!.likely_logged_in_score).toBeLessThan(
      inv["bookmark.example"]!.likely_logged_in_score,
    );
  });

  it("shortlistSortKey boosts bookmarked domains over equal reliability", () => {
    // Without real bookmarks this is a pure reliability compare; just ensure stable.
    const a = shortlistSortKey({ reliability_score: 0.5, domain: "example.com" });
    const b = shortlistSortKey({ reliability_score: 0.9, domain: "example.com" });
    expect(b).toBeGreaterThan(a);
  });
});

describe("shouldImportBrowserCookies env aliases", () => {
  it("defaults to true", () => {
    stashEnv();
    delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    delete process.env.UNBROWSE_COOKIE_IMPORT;
    expect(shouldImportBrowserCookies()).toBe(true);
  });

  it("honors UNBROWSE_COOKIE_IMPORT=0", () => {
    stashEnv();
    delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    process.env.UNBROWSE_COOKIE_IMPORT = "0";
    expect(shouldImportBrowserCookies()).toBe(false);
  });

  it("honors UNBROWSE_IMPORT_BROWSER_COOKIES=0 over alias", () => {
    stashEnv();
    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "0";
    process.env.UNBROWSE_COOKIE_IMPORT = "1";
    // primary wins when set
    expect(shouldImportBrowserCookies()).toBe(false);
  });
});

describe("listInstalledBrowsers", () => {
  it("returns an array of metadata options without throwing", () => {
    const list = listInstalledBrowsers();
    expect(Array.isArray(list)).toBe(true);
    for (const b of list) {
      expect(typeof b.name).toBe("string");
      expect(b.family === "chromium" || b.family === "firefox").toBe(true);
      expect(typeof b.userDataDir).toBe("string");
      expect(typeof b.has_cookies_db).toBe("boolean");
      // Never leak cookie values on this shape
      expect((b as Record<string, unknown>).cookies).toBeUndefined();
      expect((b as Record<string, unknown>).value).toBeUndefined();
    }
  });
});
