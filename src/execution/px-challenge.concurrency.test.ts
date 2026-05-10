/**
 * plan-v13 Day 4 (Luminaries) — sub-agent C
 *
 * Mirrors src/execution/cf-challenge.concurrency.test.ts for the PerimeterX
 * challenge seed (px-challenge.ts). Verifies:
 *   1. Dynamic `await import("./px-challenge.js")` is module-cached — three
 *      concurrent imports resolve to the SAME module record (same function
 *      reference for `extractPxBundleUrl`).
 *   2. `extractPxBundleUrl` is pure: 100 concurrent invocations against
 *      distinct PX bodies (each with a unique uuid pair) each return the URL
 *      derived from THEIR OWN body, with no clobber from a sibling call.
 *   3. The px-challenge.ts source has no module-level mutable bindings
 *      (`let` at top level) — only `const PX_BUNDLE_RE` and the imported
 *      `runBundleReplay` should appear at module scope.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

describe("px-challenge concurrency", () => {
  test("Test 1: concurrent dynamic imports resolve to the same module instance", async () => {
    const [a, b, c] = await Promise.all([
      import("./px-challenge.js"),
      import("./px-challenge.js"),
      import("./px-challenge.js"),
    ]);
    // Same function reference proves ESM module caching across concurrent
    // dynamic imports — no double-init, no race re-evaluating the top level.
    expect(a.extractPxBundleUrl).toBe(b.extractPxBundleUrl);
    expect(b.extractPxBundleUrl).toBe(c.extractPxBundleUrl);
    expect(a.solvePxAndRetry).toBe(b.solvePxAndRetry);
    // Sanity: module namespace itself is the same object reference.
    expect(a).toBe(b);
  });

  test("Test 2: 100 concurrent extractPxBundleUrl calls each return their own body's bundle URL", async () => {
    const { extractPxBundleUrl } = await import("./px-challenge.js");

    // Build a unique uuid-shaped string from an index. Format must match the
    // PX regex /([a-f0-9-]{36})/ — 36 chars of hex+hyphens. We synthesize:
    // 8-4-4-4-12 with the index encoded in the trailing 12 hex chars.
    const uuidFor = (i: number, salt: string): string => {
      const tail = (i.toString(16) + salt).slice(0, 12).padStart(12, "0");
      return `aaaaaaaa-bbbb-cccc-dddd-${tail}`;
    };

    const N = 100;
    const cases = Array.from({ length: N }, (_, i) => {
      const u1 = uuidFor(i, "abcdef012345");
      const u2 = uuidFor(i, "fedcba543210");
      const bundlePath = `/${u1}/${u2}/init.js`;
      const url = `https://site${i}.example.com/path/${i}`;
      const body = `<html><head><script src="${bundlePath}"></script></head><body>px challenge ${i}</body></html>`;
      const expected = `https://site${i}.example.com${bundlePath}`;
      return { body, url, expected, i };
    });

    // Fire all 100 in parallel via Promise.all. Each call is sync but the
    // microtask interleave still exercises any accidentally-shared closure
    // state that would surface as cross-call corruption.
    const results = await Promise.all(
      cases.map((c) =>
        Promise.resolve().then(() => extractPxBundleUrl(c.body, c.url)),
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

  test("Test 3: px-challenge.ts has no module-level mutable bindings", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "px-challenge.ts"), "utf8");
    const lines = src.split("\n");

    // Track brace depth so we only flag bindings at module scope.
    // Strip block comments and line comments before counting braces, then
    // detect module-level `let ` (any leading whitespace at depth 0 still
    // counts).
    let depth = 0;
    let inBlockComment = false;
    const moduleLetLines: { line: number; text: string }[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];

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
