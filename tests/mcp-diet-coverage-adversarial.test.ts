// Day 5 (Lost Sheep) adversarial test for AC3 — diet edge cases.
//
// The Day-4 base test (tests/mcp-diet-coverage.test.ts) proves the
// happy path: oversize string + oversize array get capped. This file
// hunts the boundary cases that would silently break `dietIfOversize`
// once it lands inside `successResult`.
//
// All four tests are RED today (successResult is not yet exported).
// After AC3 ships, all four must turn green without further edits.
//
// Import shape matches the Day-4 test: `mcp.successResult(...)`.

import { describe, expect, test } from "bun:test";
import * as mcp from "../src/mcp.js";

const SIZE_BUDGET_CHARS = 25_000;

function getSuccessResult(): ((value: unknown, summary?: string) => unknown) {
  const fn = (mcp as Record<string, unknown>).successResult;
  if (typeof fn !== "function") {
    // Force a failure with a clear message — Day 7 exports this.
    throw new Error(
      "src/mcp.ts must export `successResult` before AC3 diet edge cases can be exercised.",
    );
  }
  return fn as (value: unknown, summary?: string) => unknown;
}

function wireSize(result: unknown): number {
  return JSON.stringify(result).length;
}

describe("MCP diet coverage — adversarial edge cases (AC3 lost sheep)", () => {
  // CASE 1 — UTF-16 surrogate pair at the truncation boundary.
  // REASON: If `truncateOversizeStrings` uses `String.prototype.slice`
  // on code-unit 2000, a high surrogate at index 1999 paired with its
  // low surrogate at index 2000 will be split, producing a lone
  // surrogate. JSON.stringify still succeeds but the marker / preview
  // is malformed. The codepoint-safe path uses Array.from or for-of.
  // After AC3, the truncated string must remain valid UTF-16
  // (no lone surrogates).
  test("string truncation must not split a UTF-16 surrogate pair at the boundary", () => {
    const successResult = getSuccessResult();

    // 1998 ASCII chars, then a 1-codepoint emoji (2 code units) that
    // straddles the 2000-code-unit boundary, then padding so the total
    // is oversize.
    const head = "a".repeat(1998);
    const straddler = "\u{1F600}"; // U+1F600 = D83D DE00 (2 code units)
    const tail = "b".repeat(120_000);
    const evil = head + straddler + tail;

    const result = successResult({ payload: evil }, "surrogate-boundary");
    const serialized = JSON.stringify(result);

    // No lone high or low surrogate in the wire output.
    let lone = false;
    for (let i = 0; i < serialized.length; i++) {
      const code = serialized.charCodeAt(i);
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const isLow = code >= 0xdc00 && code <= 0xdfff;
      if (isHigh) {
        const next = serialized.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          lone = true;
          break;
        }
        i++; // consumed the valid pair
      } else if (isLow) {
        lone = true;
        break;
      }
    }
    expect(
      lone,
      "Diet must use codepoint-safe truncation (Array.from / for-of) so the boundary never splits a surrogate pair. A lone surrogate leaked through.",
    ).toBe(false);

    expect(wireSize(result)).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
  });

  // CASE 2 — Deeply nested oversize string.
  // REASON: A leaf 8 levels deep should still be truncated. If diet
  // only inspects top-level keys, the budget blows on nested SSR
  // payloads (jmail thread.message.body.html_parts[0].raw, etc.).
  test("diet must recurse into deeply nested objects to truncate leaf strings", () => {
    const successResult = getSuccessResult();

    const leaf = "z".repeat(100_000);
    const nested = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: leaf } } } } } } },
    };

    const result = successResult(nested, "deep-nesting");
    const size = wireSize(result);

    expect(
      size,
      `Deeply nested leaf (${leaf.length} chars at 8 levels) blew the budget at ${size}. Diet must recurse, not just shallow-scan top-level keys.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
  });

  // CASE 3 — Array of >50 oversize strings.
  // REASON: Two diet rules interact. capOversizeArrays (>50 items)
  // truncates the array; truncateOversizeStrings (>2000 chars each)
  // truncates each item. If cap-array runs first, the strings in the
  // dropped tail are saved from inspection — fine. But each retained
  // item must still be string-truncated. If string-truncate runs
  // first across 100 huge items, we pay the cost on items we are
  // about to drop anyway. Either order is acceptable AS LONG AS the
  // final wire size is under budget.
  test("array of 100 oversize strings must be both length-capped and string-truncated under budget", () => {
    const successResult = getSuccessResult();

    const huge = "q".repeat(10_000);
    const arr = Array.from({ length: 100 }, () => huge);

    const result = successResult({ items: arr }, "array-of-oversize-strings");
    const size = wireSize(result);

    expect(
      size,
      `Array of 100 x 10_000-char strings wired at ${size}. Both capOversizeArrays and truncateOversizeStrings must fire together to land under ${SIZE_BUDGET_CHARS}.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);
  });

  // CASE 4 — response_body is a JSON string encoding a huge object.
  // REASON: When `unbrowse_execute` returns a 200 with a giant JSON
  // body, the result is `{ response_body: "<huge JSON string>" }`.
  // From the diet's view, response_body is a STRING. The right
  // behavior is: do NOT parse-and-recurse (parsing untrusted JSON
  // just to truncate is a perf + safety trap); DO truncate the
  // string itself. The string-truncation path must fire and the
  // truncation marker must appear in the body field.
  test("response_body holding a serialized huge object must be truncated as a string, not parsed", () => {
    const successResult = getSuccessResult();

    const innerHuge = JSON.stringify({ huge: "x".repeat(120_000) });
    const result = successResult(
      { response_body: innerHuge, status_code: 200 },
      "response-body-string",
    );
    const size = wireSize(result);
    const serialized = JSON.stringify(result);

    expect(
      size,
      `response_body string (${innerHuge.length} chars) wired at ${size}. Diet must truncate response_body as a flat string.`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_CHARS);

    expect(
      serialized.includes("truncated") || serialized.includes("[truncated"),
      "Truncation marker must remain visible so the agent can see the body was capped.",
    ).toBe(true);
  });
});
