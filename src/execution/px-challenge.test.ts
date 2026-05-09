/**
 * Unit tests for plan-v13 Tier 2B PerimeterX challenge helpers.
 * Mirrors the shape of cf-challenge tests: literature-shaped synthetic
 * bodies, no live network. Validates regex and stub contract.
 */

import { describe, expect, test } from "bun:test";
import { extractPxBundleUrl, solvePxAndRetry } from "./px-challenge.js";

describe("extractPxBundleUrl", () => {
  test("happy literature body — extracts absolute /<uuid>/<uuid>/init.js URL", () => {
    const body = `<html><head><script src="/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js"></script></head></html>`;
    const out = extractPxBundleUrl(body, "https://www.canadagoose.com/");
    expect(out).not.toBeNull();
    expect(out).toContain("/init.js");
    expect(out).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    // Must be absolute, anchored on the request origin.
    expect(out!.startsWith("https://www.canadagoose.com/")).toBe(true);
  });

  test("negative — non-PX body returns null", () => {
    const body = `<html><head><title>Hello world</title><script src="/static/app.js"></script></head></html>`;
    expect(extractPxBundleUrl(body, "https://example.com/")).toBeNull();
  });

  test("negative — Cloudflare challenge body must NOT match PX regex", () => {
    // Different vendor — PX must not steal CF challenges.
    const body = `<html><script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/abcdef0123456789/main.js"></script></html>`;
    expect(extractPxBundleUrl(body, "https://blocked.example.com/")).toBeNull();
    expect(extractPxBundleUrl(body, "https://blocked.example.com/")).toBeNull();
  });

  // ----- Adversarial luminaries (plan-v13 Tier 2B Step 4 sub-agent A) -----
  // Each test probes a falsifiable edge of PX_BUNDLE_RE. A failing case
  // here is a "lost sheep" (Luke 15:4) — DO NOT patch the helper inline;
  // surface the gap for Step 6 (Dominion).

  test("adversarial 1 — unquoted src attribute returns null (regex requires quotes)", () => {
    const body = `<script src=/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js></script>`;
    expect(extractPxBundleUrl(body, "https://www.canadagoose.com/")).toBeNull();
  });

  test("adversarial 2 — non-UUID 32-char hex app id returns null (regex requires 36-char hyphenated)", () => {
    const body = `<script src="/abcdef0123456789abcdef0123456789/abcdef0123456789abcdef0123456789/init.js"></script>`;
    expect(extractPxBundleUrl(body, "https://www.canadagoose.com/")).toBeNull();
  });

  test("adversarial 3 — mismatched id lengths returns null", () => {
    const body = `<script src="/short-id/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js"></script>`;
    expect(extractPxBundleUrl(body, "https://www.canadagoose.com/")).toBeNull();
  });

  test("adversarial 4 — empty / null / undefined body returns null cleanly", () => {
    expect(extractPxBundleUrl("", "https://x.com")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractPxBundleUrl(null as any, "https://x.com")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractPxBundleUrl(undefined as any, "https://x.com")).toBeNull();
  });

  test("adversarial 5 — bundle URL inside HTML comment returns null (Step 5 Creatures sub-agent B tightened)", () => {
    // PX regex inherits CF-tightening — comment-only context correctly returns null.
    // Step 5 stripped HTML comments before matching AND requires <script preceding src=.
    // Random hyphenated 36-char strings no longer match (UUID-shape required).
    const body = `<!-- src="/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js" -->`;
    expect(extractPxBundleUrl(body, "https://www.canadagoose.com/")).toBeNull();
  });

  test("adversarial 5b — non-UUID hyphenated 36-char string returns null (UUID-shape gate)", () => {
    // Pre-Step-5 regex was `[a-f0-9-]{36}` which matched `not-a-real-uuid-but-36-chars-aaaaaa`.
    // Tightened pattern requires the canonical 8-4-4-4-12 hex layout.
    const body = `<script src="/not-a-real-uuid-but-36-chars-aaaaaa/not-a-real-uuid-but-36-chars-aaaaaa/init.js"></script>`;
    expect(extractPxBundleUrl(body, "https://www.canadagoose.com/")).toBeNull();
  });

  // ----- Adversarial creatures (plan-v13 Tier 2B Step 4 sub-agent C) -----
  // Hunt false-negatives (should match but might not) and false-positives
  // (should not match but might). Lost sheep get flagged for Step 6.

  test("adversarial 6 — <script> with onload + src interleaved should match", () => {
    const body = `<script onload="px.init()" src="/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js" defer></script>`;
    const out = extractPxBundleUrl(body, "https://www.canadagoose.com/");
    expect(out).not.toBeNull();
    expect(out).toContain("/init.js");
  });

  test("adversarial 7 — CSP nonce-bound script should match", () => {
    const body = `<script nonce="abc123" src="/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js"></script>`;
    const out = extractPxBundleUrl(body, "https://www.canadagoose.com/");
    expect(out).not.toBeNull();
    expect(out).toContain("/init.js");
  });

  test("adversarial 8 — bundle path inside JSON config blob (false-positive trap)", () => {
    // Predict: regex requires `src=["']` — JSON `"bundleUrl":"..."` has no
    // src= prefix, so should return null.
    const body = `<script>window.__PX_CONFIG__={"bundleUrl":"/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js"};</script>`;
    expect(extractPxBundleUrl(body, "https://www.canadagoose.com/")).toBeNull();
  });

  test("adversarial 9 — bundle URL with cache-busting query string strips query", () => {
    // Predict: regex stops at `\.js` — returned path should NOT include `?v=...`.
    const body = `<script src="/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js?v=20260509"></script>`;
    const out = extractPxBundleUrl(body, "https://www.canadagoose.com/");
    expect(out).not.toBeNull();
    expect(out).toContain("/init.js");
    expect(out).not.toContain("?v=");
    expect(out).not.toContain("20260509");
  });
});

describe("solvePxAndRetry", () => {
  test("stub contract — returns null today (pinned until Step 6 Dominion)", async () => {
    const result = await solvePxAndRetry({
      url: "https://www.canadagoose.com/",
      body: `<script src="/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/init.js"></script>`,
    });
    expect(result).toBeNull();
  });

  // ----- Adversarial sub-agent D (Day 5 Creatures) -----
  // Verifies the null-on-bad-input contract under degraded inputs. Future
  // Step 6 implementation MUST preserve this contract.

  test("adversarial D1 — empty body returns null cleanly", async () => {
    const result = await solvePxAndRetry({ url: "https://x.com", body: "" });
    expect(result).toBeNull();
  });

  test("adversarial D2 — missing url returns null cleanly", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await solvePxAndRetry({ url: "", body: "<html>..." } as any);
    expect(result).toBeNull();
  });

  test("adversarial D3 — malformed cookies (wrong shape) returns null cleanly", async () => {
    const result = await solvePxAndRetry({
      url: "https://x.com",
      body: "<html>",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cookies: [{ no_name: true } as any],
    });
    expect(result).toBeNull();
  });

  test("adversarial D4 — all-options input returns null cleanly (stub today)", async () => {
    const result = await solvePxAndRetry({
      url: "https://x.com",
      body: "<html>",
      cookies: [{ name: "foo", value: "bar" }],
      kuriBase: "http://x",
      proxy: "http://y",
      timeoutMs: 5000,
    });
    expect(result).toBeNull();
  });
});

describe("solvePxAndRetry self-verify gate", () => {
  // ----- Self-verify gate (Day 6 Dominion sub-agent B) -----
  // Defensive check inside solvePxAndRetry: PX signature must be present
  // in the body OR seeded cookies. Otherwise we treat this as upstream
  // misclassification and short-circuit before invoking runBundleReplay.

  test("self-verify B1 — body with _pxhd mention proceeds past gate (still null today)", async () => {
    const result = await solvePxAndRetry({
      url: "https://www.canadagoose.com/",
      body: `<html><script>var foo="_pxhd";</script></html>`,
    });
    // Stub still returns null after the gate (sub-agent C wires the rest).
    expect(result).toBeNull();
  });

  test("self-verify B2 — no PX signatures and no PX cookies returns null at gate", async () => {
    const result = await solvePxAndRetry({
      url: "https://example.com/",
      body: `<html><head><title>Hello</title></head></html>`,
      cookies: [{ name: "session", value: "abc" }],
    });
    expect(result).toBeNull();
  });

  test("self-verify B3 — no PX body but _pxhd in input.cookies proceeds past gate", async () => {
    const result = await solvePxAndRetry({
      url: "https://www.canadagoose.com/",
      body: `<html><head><title>Plain</title></head></html>`,
      cookies: [{ name: "_pxhd", value: "armed-value" }],
    });
    // Stub still returns null after the gate (sub-agent C wires the rest).
    expect(result).toBeNull();
  });
});
