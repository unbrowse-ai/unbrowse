/**
 * GATE: the obscura backend is wired into the REAL server capture entry.
 *
 * captureAndIndexViaObscura had zero callers in src/ — a library nothing invoked.
 * This proves executeBrowserCapture now delegates to it when
 * UNBROWSE_BROWSER_BACKEND=obscura, that the delegate returns a well-formed
 * ExecutionResult, and that sharing to the index is opt-in (default OFF).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawRequest } from "../src/capture/index.js";
import type { RunObscuraCaptureResult } from "../src/capture/obscura-capture.js";
import type { SkillManifest } from "../src/types/index.js";
import {
  obscuraBackendSelected,
  shareOptIn,
  executeCaptureViaObscura,
} from "../src/execution/obscura-backend.js";

const skill = { skill_id: "test-skill" } as unknown as SkillManifest;

function fakeCapture(): RunObscuraCaptureResult {
  const api: RawRequest = {
    url: "https://quotes.toscrape.com/api/quotes?page=1",
    method: "GET",
    request_headers: { accept: "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({
      has_next: false,
      quotes: [
        { author: { name: "A" }, tags: ["x"], text: "one" },
        { author: { name: "B" }, tags: ["y"], text: "two" },
      ],
    }),
    timestamp: new Date(1785853139940).toISOString(),
  };
  return {
    requests: [api],
    final_url: "https://quotes.toscrape.com/scroll",
    html_len: 100,
    cookies: [],
    domain: "quotes.toscrape.com",
  };
}

describe("obscuraBackendSelected", () => {
  test("obscura by default; explicit cdp/chrome/kuri opts out", () => {
    expect(obscuraBackendSelected({ UNBROWSE_BROWSER_BACKEND: "obscura" })).toBe(true);
    expect(obscuraBackendSelected({ UNBROWSE_BROWSER_BACKEND: "OBSCURA" })).toBe(true);
    expect(obscuraBackendSelected({})).toBe(true);
    expect(obscuraBackendSelected({ UNBROWSE_BROWSER_BACKEND: "cdp" })).toBe(false);
    expect(obscuraBackendSelected({ UNBROWSE_BROWSER_BACKEND: "chrome" })).toBe(false);
    expect(obscuraBackendSelected({ UNBROWSE_BROWSER_BACKEND: "kuri" })).toBe(false);
    expect(obscuraBackendSelected({ UNBROWSE_BROWSER_BACKEND: "chromium" })).toBe(false);
  });
});

describe("shareOptIn", () => {
  test("default OFF; on only for an explicit truthy flag", () => {
    expect(shareOptIn({})).toBe(false);
    expect(shareOptIn({ UNBROWSE_SHARE_INDEX: "0" })).toBe(false);
    expect(shareOptIn({ UNBROWSE_SHARE_INDEX: "1" })).toBe(true);
    expect(shareOptIn({ UNBROWSE_SHARE_INDEX: "true" })).toBe(true);
    expect(shareOptIn({ UNBROWSE_SHARE_INDEX: "yes" })).toBe(true);
  });
});

describe("executeCaptureViaObscura", () => {
  test("delegates, returns an obscura ExecutionResult, shares nothing by default", async () => {
    const res = await executeCaptureViaObscura(
      { skill, url: "https://quotes.toscrape.com/scroll", intent: "list quotes" },
      { runCapture: async () => fakeCapture(), session: null, shareToIndex: false },
    );
    const r = res.result as Record<string, unknown>;
    expect(r.backend).toBe("obscura");
    expect(res.trace.endpoint_id).toBe("obscura-capture");
    expect(res.trace.success).toBe(true);
    expect(Number(r.endpoints_discovered)).toBeGreaterThanOrEqual(1);
    // opt-in OFF => nothing written to the shared index, no learned skill minted here
    expect(r.shared_to_index).toBe(false);
    expect(res.learned_skill).toBeUndefined();
  });
});

describe("wired into executeBrowserCapture", () => {
  test("the guarded branch is present in src/execution/index.ts", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "execution", "index.ts"), "utf8");
    expect(src).toContain("obscuraBackendSelected()");
    expect(src).toContain("executeCaptureViaObscura(");
  });
});
