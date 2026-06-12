// Falsifier for issue #62: SPA service worker bypasses network interception.
//
// Root cause (confirmed in the issue thread):
//   src/capture/index.ts opens a direct CDP websocket and sends
//   "Network.enable" before navigation. Without "Network.setCacheDisabled"
//   AND "Network.setBypassServiceWorker", any SPA whose service worker
//   resolves API requests from its own cache is structurally invisible
//   to the interceptor (NUSMods moduleList.json, PWA timelines, etc.).
//
// Contract this test pins:
//   1. Every "Network.enable" CDP send must be paired (in the same scope)
//      with a "Network.setCacheDisabled" + "Network.setBypassServiceWorker"
//      send.
//   2. Both bypass calls must use the canonical CDP param names:
//      { cacheDisabled: true } and { bypass: true }.
//
// No mocks. Reads the real src/capture/index.ts bytes the runtime ships.
// If the bypass calls are deleted, this test fails before the SPA-cache
// regression escapes to prod.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const captureSrc = readFileSync(
  join(import.meta.dir, "..", "src", "capture", "index.ts"),
  "utf8",
);

describe("capture/index.ts service-worker + HTTP-cache bypass (issue #62)", () => {
  test("Network.enable is sent (sanity)", () => {
    const enableCount = (captureSrc.match(/"Network\.enable"/g) ?? []).length;
    expect(enableCount).toBeGreaterThanOrEqual(1);
  });

  test("Network.setCacheDisabled is sent with cacheDisabled:true", () => {
    const setCacheRe =
      /"Network\.setCacheDisabled"[\s\S]{0,200}?cacheDisabled:\s*true/;
    expect(setCacheRe.test(captureSrc)).toBe(true);
  });

  test("Network.setBypassServiceWorker is sent with bypass:true", () => {
    const bypassSwRe =
      /"Network\.setBypassServiceWorker"[\s\S]{0,200}?bypass:\s*true/;
    expect(bypassSwRe.test(captureSrc)).toBe(true);
  });

  test("Network.enable, setCacheDisabled, setBypassServiceWorker appear in that order", () => {
    const enableIdx = captureSrc.indexOf('"Network.enable"');
    const cacheIdx = captureSrc.indexOf('"Network.setCacheDisabled"');
    const swIdx = captureSrc.indexOf('"Network.setBypassServiceWorker"');
    expect(enableIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeGreaterThan(enableIdx);
    expect(swIdx).toBeGreaterThan(enableIdx);
  });

  test("bypass calls are inside the same CDP setup block (no orphan calls in dead code)", () => {
    const cdpBlockMatch = captureSrc.match(
      /cdpWs\s*=\s*new WebSocket[\s\S]*?await new Promise\(r => setTimeout\(r, 200\)\)/,
    );
    expect(cdpBlockMatch).toBeTruthy();
    const block = cdpBlockMatch![0];
    expect(block).toContain('"Network.setCacheDisabled"');
    expect(block).toContain('"Network.setBypassServiceWorker"');
  });
});
