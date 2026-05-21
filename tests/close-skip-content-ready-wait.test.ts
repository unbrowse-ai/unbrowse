import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Trace evidence (~/.unbrowse/logs/unbrowse-2026-05-21.log gate-060/061/062)
// showed close enrich-capture eating 15-17s of waitForContentReady budget on
// pages whose intercepted+HAR were empty, producing zero new endpoints.
//
// Fix: close passes `skipContentReadyWait: true` to flushBrowseCapture so the
// 14s wait window (1s + readyState 5s + intent-aware 8s) is bypassed on the
// terminal phase. Sync keeps the default (false) because a mid-session
// checkpoint may legitimately want a freshly-firing XHR.
//
// These pins are STRUCTURAL — they read routes.ts and assert the option is
// present on the close call and absent on the sync call. If a future refactor
// moves either call, the pin guides the refactor; it cannot silently regress
// the 15s blocker on close.

const ROUTES_PATH = resolve(import.meta.dir, "..", "src", "api", "routes.ts");
const ROUTES_SRC = readFileSync(ROUTES_PATH, "utf8");

describe("close path bypasses waitForContentReady", () => {
  test("flushBrowseCapture accepts skipContentReadyWait in its options type", () => {
    expect(ROUTES_SRC).toContain(
      "options: { queueIndex?: boolean; queuePublish?: boolean; skipContentReadyWait?: boolean }",
    );
  });

  test("flushBrowseCapture threads skipContentReadyWait into enrichPassiveCaptureRequests", () => {
    expect(ROUTES_SRC).toContain("skipContentReadyWait: options.skipContentReadyWait,");
  });

  test("close handler passes skipContentReadyWait: true (the terminal phase short-circuits the wait)", () => {
    expect(ROUTES_SRC).toContain(
      'flushBrowseCapture(session, { queueIndex: true, queuePublish: true, skipContentReadyWait: true })',
    );
  });

  test("sync handler keeps the default (mid-session checkpoint may want a freshly-firing XHR)", () => {
    expect(ROUTES_SRC).toContain(
      'flushBrowseCapture(session, { queueIndex: true, queuePublish: true })',
    );
  });
});
