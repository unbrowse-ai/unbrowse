import { describe, expect, it } from "bun:test";
import { bookmarkDomainsFromJson, pickMostRecentBrowser, browserPreferences } from "../src/auth/browser-preferences.ts";

describe("browser-preferences", () => {
  it("bookmarkDomainsFromJson: flattens the tree to eTLD+1 domains, redacted + deduped", () => {
    const fixture = {
      roots: {
        bookmark_bar: {
          children: [
            { type: "url", url: "https://news.ycombinator.com/item?id=1", name: "HN" },
            { type: "folder", children: [
              { type: "url", url: "https://www.github.com/foo/bar", name: "repo" },
              { type: "url", url: "https://github.com/baz", name: "another" }, // same eTLD+1 → dedupe
            ] },
          ],
        },
        other: { children: [{ type: "url", url: "https://docs.python.org/3/", name: "py" }] },
        synced: { children: [] },
      },
    };
    const domains = bookmarkDomainsFromJson(fixture).sort();
    expect(domains).toEqual(["github.com", "python.org", "ycombinator.com"]); // eTLD+1, deduped
    // redaction: no subdomain/path leaked
    expect(domains.some((d) => d.includes("/"))).toBe(false);
    expect(domains).not.toContain("www.github.com");
  });

  it("bookmarkDomainsFromJson: tolerates malformed / empty input without throwing", () => {
    expect(bookmarkDomainsFromJson(null)).toEqual([]);
    expect(bookmarkDomainsFromJson({})).toEqual([]);
    expect(bookmarkDomainsFromJson({ roots: { bookmark_bar: { children: [{ type: "url", url: "not a url" }] } } })).toEqual([]);
  });

  it("pickMostRecentBrowser: returns a valid pick or null (machine-dependent, never throws)", () => {
    const pick = pickMostRecentBrowser();
    if (pick !== null) {
      expect(typeof pick.name).toBe("string");
      expect(pick.lastActiveMs).toBeGreaterThan(0);
      expect(pick.userDataDir.length).toBeGreaterThan(0);
    }
  });

  it("browserPreferences: returns the redacted shape (browser-by-recency + bookmarks + recent)", () => {
    const prefs = browserPreferences({ sinceDaysAgo: 7 });
    expect(prefs.redacted).toBe(true);
    expect(Array.isArray(prefs.bookmark_domains)).toBe(true);
    expect(Array.isArray(prefs.recent_domains)).toBe(true);
    // every surfaced domain is eTLD+1-redacted (no path/query/subdomain markers)
    for (const d of [...prefs.bookmark_domains, ...prefs.recent_domains]) {
      expect(d).not.toContain("/");
      expect(d).not.toContain("?");
    }
  });
});
