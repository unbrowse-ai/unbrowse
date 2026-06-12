// FALSIFIER for the new auth-cookies lane (2026-05-19).
//
// Adds 8 probes that exercise the platform's auto-cookie-injection
// path from the user's Dia / Chrome / Arc / Brave / Edge / Vivaldi /
// Opera SQLite store. Bench coverage:
//
//   - Corpus carries the new lane with 8 entries.
//   - Collector surfaces `browser_cookies` evidence in capture.meta.json
//     so the in-thread judge can distinguish "no local cookies, exclude"
//     from "cookies present, login wall = real bug".
//   - GATE_JUDGE.md teaches the rubric for two regimes (logged-in vs
//     not-logged-in) and the failure mode (cookies present but
//     auth wall returned).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("corpus-gate.txt — auth-cookies lane", () => {
  const corpus = readFileSync(join(repoRoot, "harness", "probes", "corpus-gate.txt"), "utf8");
  const lines = corpus.split("\n").filter((l) => l.startsWith("auth-cookies"));

  test("at least 8 auth-cookies probes are declared", () => {
    expect(lines.length).toBeGreaterThanOrEqual(8);
  });

  test("each probe uses the cookie-injected strategy and dia auth source", () => {
    for (const line of lines) {
      const parts = line.split("|").map((s) => s.trim());
      expect(parts[0]).toBe("auth-cookies");
      expect(parts[1]).toBe("dia");
      expect(parts[3]).toBe("cookie-injected");
      // intent + contextUrl are non-empty
      expect(parts[4].length).toBeGreaterThan(0);
      expect(parts[5]).toMatch(/^https?:\/\//);
    }
  });

  test("header lane summary lists the new lane and updated total", () => {
    const probeCount = corpus.split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#")).length;
    expect(corpus).toContain("auth-cookies (8)");
    expect(corpus).toContain(`Total: ${probeCount}`);
  });
});

describe("GATE_JUDGE.md — auth-cookies rubric bullet", () => {
  const judge = readFileSync(join(repoRoot, "harness", "probes", "GATE_JUDGE.md"), "utf8");

  test("auth-cookies is listed in the lane enum at the top", () => {
    expect(judge).toContain("`auth-cookies`");
  });

  test("rubric distinguishes the two regimes (logged-in vs not-logged-in)", () => {
    // Find the auth-cookies bullet and confirm both regimes are described.
    const idx = judge.indexOf("- `auth-cookies`");
    expect(idx).toBeGreaterThan(0);
    const bullet = judge.slice(idx, judge.indexOf("\n- `", idx) > 0 ? judge.indexOf("\n- `", idx) : idx + 3500);
    expect(bullet.toLowerCase()).toMatch(/logged in|cookies present/);
    expect(bullet.toLowerCase()).toMatch(/not logged in|no cookies|no dia/);
    // The failure mode that IS a real bug.
    expect(bullet.toLowerCase()).toMatch(/login wall|retrieve_fail_error_body/);
  });

  test("rubric tells the judge to quote a personalized data field on PASS", () => {
    const idx = judge.indexOf("- `auth-cookies`");
    const bullet = judge.slice(idx, idx + 3500);
    expect(bullet.toLowerCase()).toMatch(/personalized|inbox|repo|issue|subscription/);
  });
});

describe("collector — surfaces cookie-injection evidence in capture.meta.json", () => {
  const collector = readFileSync(join(repoRoot, "scripts", "mcp-gate-parallel-collect.ts"), "utf8");
  const helper = readFileSync(join(repoRoot, "scripts", "mcp-gate-parallel-helpers.ts"), "utf8");

  test("collector passes browse/go evidence into capture metadata", () => {
    expect(collector).toContain("buildCaptureMeta({ cb, eps, sb, evalRes, skillId, isoSelfCheck, go })");
  });

  test("helper stores the cookies_injected count from browse/go", () => {
    expect(helper).toContain("cookies_injected");
    expect(helper).toContain("go?.body?.cookies_injected");
  });

  test("collector writes capture.meta.json via buildCaptureMeta", () => {
    expect(collector).toContain('w(dir, "capture.meta.json", JSON.stringify(');
    expect(collector).toContain("buildCaptureMeta");
  });
});
