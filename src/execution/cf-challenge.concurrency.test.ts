/**
 * plan-v14 Day 5 (Creatures) — sub-agent C
 *
 * Concurrency adversarial check on the cf-challenge seed used by
 * src/execution/index.ts:1358-1375. Verifies:
 *   1. Dynamic `await import("./cf-challenge.js")` is module-cached — two
 *      concurrent imports resolve to the SAME module record (same function
 *      reference for `extractCfBundleUrl`).
 *   2. `extractCfBundleUrl` is pure: 100 concurrent invocations against
 *      distinct bodies/URLs each return the URL derived from THEIR OWN body,
 *      with no clobber from a sibling call.
 *   3. The cf-challenge.ts source has no module-level mutable bindings
 *      (`let` at top level) — a static guard against shared-state regressions
 *      that would make `solveCfAndRetry` unsafe under concurrency.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

describe("cf-challenge concurrency", () => {
  test("Test 1: concurrent dynamic imports resolve to the same module instance", async () => {
    const [a, b, c] = await Promise.all([
      import("./cf-challenge.js"),
      import("./cf-challenge.js"),
      import("./cf-challenge.js"),
    ]);
    // Same function reference proves ESM module caching across concurrent
    // dynamic imports — no double-init, no race re-evaluating the top level.
    expect(a.extractCfBundleUrl).toBe(b.extractCfBundleUrl);
    expect(b.extractCfBundleUrl).toBe(c.extractCfBundleUrl);
    expect(a.solveCfAndRetry).toBe(b.solveCfAndRetry);
    // Sanity: module namespace itself is the same object reference.
    expect(a).toBe(b);
  });

  test("Test 2: 100 concurrent extractCfBundleUrl calls each return their own body's bundle URL", async () => {
    const { extractCfBundleUrl } = await import("./cf-challenge.js");

    // Generate 100 distinct (body, url, expectedHash) tuples. Each body
    // contains a UNIQUE hex hash so we can verify no cross-call clobbering.
    const N = 100;
    const cases = Array.from({ length: N }, (_, i) => {
      // 16 hex chars derived from index — guaranteed unique and lowercase.
      const hash = i.toString(16).padStart(16, "0") + "abcdef0123456789";
      const variant = i % 2 === 0 ? "g" : "b";
      const bundlePath = `/cdn-cgi/challenge-platform/h/${variant}/scripts/jsd/${hash}/main.js`;
      const url = `https://site${i}.example.com/path/${i}`;
      const body = `<html><head><script src="${bundlePath}"></script></head><body>challenge ${i}</body></html>`;
      const expected = `https://site${i}.example.com${bundlePath}`;
      return { body, url, expected, i };
    });

    // Fire all 100 in parallel via Promise.all. Each call is sync but the
    // microtask interleave still exercises any accidentally-shared closure
    // state that would surface as cross-call corruption.
    const results = await Promise.all(
      cases.map((c) =>
        Promise.resolve().then(() => extractCfBundleUrl(c.body, c.url)),
      ),
    );

    for (let i = 0; i < N; i++) {
      const got = results[i];
      const want = cases[i].expected;
      expect(got).toBe(want);
    }

    // Defensive: every result is unique (no two calls produced the same URL).
    const unique = new Set(results);
    expect(unique.size).toBe(N);
  });

  test("Test 3: cf-challenge.ts has no module-level mutable bindings", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "cf-challenge.ts"), "utf8");
    const lines = src.split("\n");

    // Track brace depth so we only flag bindings at column 0 / module scope.
    // Strip block comments and line comments before counting braces, then
    // detect module-level `let ` (any leading whitespace at depth 0 still
    // counts — TS allows indented top-level statements inside conditional
    // exports, but cf-challenge has none).
    let depth = 0;
    let inBlockComment = false;
    const moduleLetLines: { line: number; text: string }[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      let line = lines[idx];

      // Strip block comments spanning the line.
      let cleaned = "";
      for (let k = 0; k < line.length; k++) {
        if (inBlockComment) {
          if (line[k] === "*" && line[k + 1] === "/") {
            inBlockComment = false;
            k++;
          }
          continue;
        }
        if (line[k] === "/" && line[k + 1] === "*") {
          inBlockComment = true;
          k++;
          continue;
        }
        if (line[k] === "/" && line[k + 1] === "/") break; // line comment
        cleaned += line[k];
      }

      // Detect a `let ` at depth 0 BEFORE updating depth for this line.
      // Module-level let must appear when the brace depth entering the line
      // is zero. We deliberately ignore `let` inside function bodies.
      if (depth === 0 && /^\s*let\s+\w/.test(cleaned)) {
        moduleLetLines.push({ line: idx + 1, text: line.trim() });
      }

      // Update depth after scanning the cleaned line.
      for (const ch of cleaned) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
    }

    if (moduleLetLines.length > 0) {
      // eslint-disable-next-line no-console
      console.error("Module-level mutable bindings found:", moduleLetLines);
    }
    expect(moduleLetLines).toEqual([]);

    // Also assert balanced braces — if this fails our depth tracker is wrong
    // and the above check is unreliable.
    expect(depth).toBe(0);
  });
});
