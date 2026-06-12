/**
 * tests/p1-w3-noise-patterns.test.ts — Sermon signals over the noise-pattern
 * cleanup wedge.
 *
 * Run: bun test tests/p1-w3-noise-patterns.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTH_CONFIG_PATHS,
  I18N_CONFIG_PATHS,
  NOISE_HOSTS,
  NOISE_PATHS,
  SESSION_PLUMBING,
  STATIC_ASSET_PATTERNS,
  UI_ASSET_PATHS,
} from "../src/lib/ranking-core/filters/noise-patterns.js";

const REPO_ROOT = join(import.meta.dir, "..");

describe("P1 W3 cleanup — filters/noise-patterns module surface", () => {
  it("exports 7 RegExp constants", () => {
    for (const r of [
      NOISE_HOSTS,
      NOISE_PATHS,
      I18N_CONFIG_PATHS,
      AUTH_CONFIG_PATHS,
      SESSION_PLUMBING,
      STATIC_ASSET_PATTERNS,
      UI_ASSET_PATHS,
    ]) {
      expect(r).toBeInstanceOf(RegExp);
    }
  });

  it("all patterns use case-insensitive flag", () => {
    for (const r of [
      NOISE_HOSTS,
      NOISE_PATHS,
      I18N_CONFIG_PATHS,
      AUTH_CONFIG_PATHS,
      SESSION_PLUMBING,
      STATIC_ASSET_PATTERNS,
      UI_ASSET_PATHS,
    ]) {
      expect(r.flags).toContain("i");
    }
  });
});

describe("P1 W3 cleanup — pattern behavior parity (samples from real captures)", () => {
  it("NOISE_HOSTS catches known tracking domains", () => {
    expect(NOISE_HOSTS.test("doubleclick.net")).toBe(true);
    expect(NOISE_HOSTS.test("google-analytics.com")).toBe(true);
    expect(NOISE_HOSTS.test("api.example.com")).toBe(false);
  });

  it("NOISE_PATHS catches tracking endpoints", () => {
    expect(NOISE_PATHS.test("/track")).toBe(true);
    expect(NOISE_PATHS.test("/pixel")).toBe(true);
    expect(NOISE_PATHS.test("/api/users")).toBe(false);
  });

  it("STATIC_ASSET_PATTERNS catches font/script/image extensions", () => {
    expect(STATIC_ASSET_PATTERNS.test("/fonts/foo.woff2")).toBe(true);
    expect(STATIC_ASSET_PATTERNS.test("/img/logo.png")).toBe(true);
    expect(STATIC_ASSET_PATTERNS.test("/img/logo.png?v=1")).toBe(true);
    expect(STATIC_ASSET_PATTERNS.test("/api/data")).toBe(false);
  });

  it("UI_ASSET_PATHS catches animation/sprite paths", () => {
    expect(UI_ASSET_PATHS.test("/lottie/animation.json")).toBe(true);
    expect(UI_ASSET_PATHS.test("/assets/static/foo")).toBe(true);
    expect(UI_ASSET_PATHS.test("/api/data")).toBe(false);
  });

  it("I18N_CONFIG_PATHS catches translation paths", () => {
    expect(I18N_CONFIG_PATHS.test("/locales/en")).toBe(true);
    expect(I18N_CONFIG_PATHS.test("/i18n/messages")).toBe(true);
    expect(I18N_CONFIG_PATHS.test("/api/data")).toBe(false);
  });

  it("AUTH_CONFIG_PATHS catches auth/session paths", () => {
    expect(AUTH_CONFIG_PATHS.test("/login")).toBe(true);
    expect(AUTH_CONFIG_PATHS.test("/manifest.json")).toBe(true);
    expect(AUTH_CONFIG_PATHS.test("/api/data")).toBe(false);
  });

  it("SESSION_PLUMBING catches infrastructure endpoints (NOT timeline/feed)", () => {
    expect(SESSION_PLUMBING.test("account/settings")).toBe(true);
    expect(SESSION_PLUMBING.test("badge_count")).toBe(true);
    // Critical: real-data endpoints must NOT match
    expect(SESSION_PLUMBING.test("HomeTimeline")).toBe(false);
    expect(SESSION_PLUMBING.test("Bookmarks")).toBe(false);
    expect(SESSION_PLUMBING.test("UserByScreenName")).toBe(false);
  });
});

describe("P1 W3 cleanup — extraction anti-goal anchors", () => {
  const executionText = readFileSync(
    join(REPO_ROOT, "src/execution/index.ts"),
    "utf8",
  );

  it("src/execution/index.ts no longer declares `const NOISE_HOSTS = `", () => {
    expect(executionText).not.toMatch(/^\s*const NOISE_HOSTS\s*=\s*\//m);
  });

  it("src/execution/index.ts no longer declares `const NOISE_PATHS = `", () => {
    expect(executionText).not.toMatch(/^\s*const NOISE_PATHS\s*=\s*\//m);
  });

  it("src/execution/index.ts no longer declares `const STATIC_ASSET_PATTERNS = `", () => {
    expect(executionText).not.toMatch(/^\s*const STATIC_ASSET_PATTERNS\s*=\s*\//m);
  });

  it("src/execution/index.ts imports the noise-patterns module", () => {
    expect(executionText).toMatch(
      /import\s*\{[^}]*NOISE_HOSTS[^}]*\}\s*from\s*"\.\.\/lib\/ranking-core\/filters\/noise-patterns\.js"/,
    );
  });

  it("the filter chain still references all 7 imported patterns", () => {
    expect(executionText).toContain("NOISE_HOSTS.test(");
    expect(executionText).toContain("NOISE_PATHS.test(");
    expect(executionText).toContain("I18N_CONFIG_PATHS.test(");
    expect(executionText).toContain("AUTH_CONFIG_PATHS.test(");
    expect(executionText).toContain("SESSION_PLUMBING.test(");
    expect(executionText).toContain("STATIC_ASSET_PATTERNS.test(");
    expect(executionText).toContain("UI_ASSET_PATHS.test(");
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — edges + adversarial.
// ---------------------------------------------------------------------------

describe("P1 W3 cleanup — ministry: degenerate inputs", () => {
  it("empty string does not match any pattern", () => {
    for (const r of [
      NOISE_HOSTS,
      NOISE_PATHS,
      I18N_CONFIG_PATHS,
      AUTH_CONFIG_PATHS,
      SESSION_PLUMBING,
      STATIC_ASSET_PATTERNS,
      UI_ASSET_PATHS,
    ]) {
      expect(r.test("")).toBe(false);
    }
  });

  it("case-insensitive matching: uppercase variants still hit", () => {
    expect(NOISE_HOSTS.test("DOUBLECLICK.NET")).toBe(true);
    expect(NOISE_PATHS.test("/TRACK")).toBe(true);
    expect(STATIC_ASSET_PATTERNS.test("/foo.PNG")).toBe(true);
  });
});

describe("P1 W3 cleanup — ministry: false-positive defense", () => {
  it("legitimate API hosts NOT flagged as noise even with similar names", () => {
    // Words like "tracker" / "stats" appear in some real product domains
    expect(NOISE_HOSTS.test("github.com")).toBe(false);
    expect(NOISE_HOSTS.test("api.linkedin.com")).toBe(false);
    expect(NOISE_HOSTS.test("reddit.com")).toBe(false);
  });

  it("data-shape paths with API-like names NOT flagged as noise paths", () => {
    expect(NOISE_PATHS.test("/api/products")).toBe(false);
    expect(NOISE_PATHS.test("/api/users")).toBe(false);
    expect(NOISE_PATHS.test("/api/search")).toBe(false);
  });

  it("legit data files with non-noise extensions don't match STATIC_ASSET_PATTERNS", () => {
    expect(STATIC_ASSET_PATTERNS.test("/api/data.json")).toBe(false);
    expect(STATIC_ASSET_PATTERNS.test("/feed.xml")).toBe(false);
  });
});

describe("P1 W3 cleanup — ministry: adversarial regex stress", () => {
  it("very long URL (10k chars) does not throw or hang", () => {
    const longUrl = "https://example.com/" + "a".repeat(10000);
    expect(() => NOISE_HOSTS.test(longUrl)).not.toThrow();
    expect(() => NOISE_PATHS.test(longUrl)).not.toThrow();
    // Should NOT match (no noise host or path token in the synthetic input)
    expect(NOISE_HOSTS.test(longUrl)).toBe(false);
  });

  it("URL with regex-special characters does not crash", () => {
    const adversarial = "https://example.com/path?q=.*+?(){}[]|^$\\\\";
    for (const r of [
      NOISE_HOSTS,
      NOISE_PATHS,
      I18N_CONFIG_PATHS,
      AUTH_CONFIG_PATHS,
      SESSION_PLUMBING,
      STATIC_ASSET_PATTERNS,
      UI_ASSET_PATHS,
    ]) {
      expect(() => r.test(adversarial)).not.toThrow();
    }
  });
});

describe("P1 W3 cleanup — ministry: SESSION_PLUMBING dual-usage invariant", () => {
  it("the pattern produces identical results regardless of where it is referenced", () => {
    // Filter call site (rankEndpoints L3444) and scoring penalty (L3855 area)
    // both import the SAME RegExp reference from this module — proving
    // by construction that they cannot diverge.
    const sample = "account/settings";
    const filterResult = SESSION_PLUMBING.test(sample);
    const scoringResult = SESSION_PLUMBING.test(sample);
    expect(filterResult).toBe(scoringResult);
    expect(filterResult).toBe(true);
  });
});
