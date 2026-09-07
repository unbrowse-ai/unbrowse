// W5 v7 build wave — foundation tests for src/cdp/{connection,chrome,target}.ts
//
// Hab 2:2 — write the vision plain. These tests hit REAL Chrome (no mocks,
// per CLAUDE.md). First run installs the pinned Chrome buildId via
// @puppeteer/browsers; subsequent runs hit the cache. Set
// `V7_CDP_TEST_SKIP=1` to short-circuit (e.g. on cold-cache CI without
// network).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import { connect } from "../src/cdp/connection.js";
import {
  ensureChrome,
  getBrowserVersion,
  PINNED_CHROME_BUILD_ID,
  probeExistingCdp,
  resolveHeadlessDefault,
  spawnChrome,
} from "../src/cdp/chrome.js";
import {
  closeTarget,
  createBrowserContext,
  createTarget,
  disposeBrowserContext,
  listTargets,
} from "../src/cdp/target.js";
import type { CDPConnection } from "../src/cdp/types.js";

const SKIP = process.env.V7_CDP_TEST_SKIP === "1";

function countHeadlessChromes(): number {
  if (process.platform === "win32") return 0;
  try {
    const out = execSync("pgrep -f 'Chrome.*--headless=new' 2>/dev/null || true", { encoding: "utf8" });
    return out
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

describe("v7 cdp foundation", () => {
  // Track conns we open so we can hard-tear-down even on test failure.
  const opened: CDPConnection[] = [];

  afterAll(async () => {
    for (const c of opened) {
      try {
        await c.close();
      } catch {
        /* swallow — we're in cleanup */
      }
    }
  });

  test("resolveHeadlessDefault honors env precedence", () => {
    expect(resolveHeadlessDefault({})).toBe(true);
    expect(resolveHeadlessDefault({ HEADLESS: "false" })).toBe(false);
    expect(resolveHeadlessDefault({ HEADLESS: "0" })).toBe(false);
    expect(resolveHeadlessDefault({ HEADLESS: "true" })).toBe(true);
    expect(resolveHeadlessDefault({ KURI_HEADLESS: "false" })).toBe(false);
    // UNBROWSE_HEADLESS overrides legacy vars.
    expect(resolveHeadlessDefault({ UNBROWSE_HEADLESS: "false", HEADLESS: "true" })).toBe(false);
    // Unknown value warns + defaults to headless.
    expect(resolveHeadlessDefault({ HEADLESS: "maybe" })).toBe(true);
  });

  test(
    "1. ensureChrome installs and returns existing binary path",
    async () => {
      if (SKIP) return;
      const bin = await ensureChrome();
      expect(bin).toBeTruthy();
      expect(existsSync(bin)).toBe(true);
      // Idempotent — second call should be fast and return same path.
      const bin2 = await ensureChrome();
      expect(bin2).toBe(bin);
      // Path should contain the pinned build.
      expect(bin).toContain(PINNED_CHROME_BUILD_ID);
    },
    { timeout: 180_000 },
  );

  test(
    "2. spawnChrome({headless:true}) produces a running process with reachable CDP endpoint",
    async () => {
      if (SKIP) return;
      const conn = await spawnChrome({ headless: true });
      opened.push(conn);
      expect(conn.pid).toBeGreaterThan(0);
      expect(conn.endpoint.startsWith("ws://")).toBe(true);
      expect(await probeExistingCdp(conn.endpoint)).toBe(true);
      // version backfill from Browser.getVersion
      expect(conn.version.toLowerCase()).toContain("chrome");
    },
    { timeout: 60_000 },
  );

  test(
    "3. connect via /json/version + call('Browser.getVersion') succeeds",
    async () => {
      if (SKIP) return;
      const conn = await spawnChrome({ headless: true });
      opened.push(conn);
      // Re-attach via HTTP discovery — exercises `connect()` separately
      // from spawnChrome's internal attachWithMeta path.
      const httpUrl = conn.endpoint.replace(/^ws:\/\/([^/]+).*$/, "http://$1");
      const conn2 = await connect(httpUrl);
      try {
        const v = await getBrowserVersion(conn2);
        expect(v.product).toContain("Chrome");
        expect(v.userAgent).toContain("Chrome");
        expect(v.revision.length).toBeGreaterThan(0);
      } finally {
        // We only close the duplicate attach — the spawned conn is reused above.
        await (conn2.client as { close: () => Promise<void> }).close();
      }
    },
    { timeout: 60_000 },
  );

  test(
    "4. createBrowserContext + createTarget produce isolated cookie jars",
    async () => {
      if (SKIP) return;
      const conn = await spawnChrome({ headless: true });
      opened.push(conn);

      const ctxA = await createBrowserContext(conn);
      const ctxB = await createBrowserContext(conn);
      expect(ctxA.browserContextId).not.toBe(ctxB.browserContextId);

      const targetA = await createTarget(conn, "about:blank", { browserContextId: ctxA.browserContextId });
      const targetB = await createTarget(conn, "about:blank", { browserContextId: ctxB.browserContextId });
      expect(targetA.sessionId).toBeTruthy();
      expect(targetB.sessionId).toBeTruthy();
      expect(targetA.sessionId).not.toBe(targetB.sessionId);

      // Plant a cookie in context A only.
      await conn.call(
        "Network.setCookie",
        { name: "v7_w5_isolation", value: "A", url: "https://example.com/" },
        targetA.sessionId,
      );

      // A should see it.
      const aCookies = await conn.call<{ urls: string[] }, { cookies: Array<{ name: string; value: string }> }>(
        "Network.getCookies",
        { urls: ["https://example.com/"] },
        targetA.sessionId,
      );
      const aHas = aCookies.cookies.some((c) => c.name === "v7_w5_isolation" && c.value === "A");
      expect(aHas).toBe(true);

      // B must NOT see it (separate browser context).
      const bCookies = await conn.call<{ urls: string[] }, { cookies: Array<{ name: string; value: string }> }>(
        "Network.getCookies",
        { urls: ["https://example.com/"] },
        targetB.sessionId,
      );
      const bHas = bCookies.cookies.some((c) => c.name === "v7_w5_isolation");
      expect(bHas).toBe(false);

      // listTargets enumeration includes both.
      const targets = await listTargets(conn);
      const idsSeen = new Set(targets.map((t) => t.targetId));
      expect(idsSeen.has(targetA.targetId)).toBe(true);
      expect(idsSeen.has(targetB.targetId)).toBe(true);

      await closeTarget(targetA);
      await closeTarget(targetB);
      await disposeBrowserContext(ctxA);
      await disposeBrowserContext(ctxB);
    },
    { timeout: 60_000 },
  );

  test(
    "5. AsyncDisposable: `using` scope exit kills Chrome cleanly (no zombies)",
    async () => {
      if (SKIP) return;
      const baseline = countHeadlessChromes();
      let pidUnderScope = 0;
      {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        await using conn = await spawnChrome({ headless: true });
        pidUnderScope = conn.pid;
        expect(pidUnderScope).toBeGreaterThan(0);
        // Inside scope, headless-chrome count is >= baseline + 1
        expect(countHeadlessChromes()).toBeGreaterThanOrEqual(baseline + 1);
      }
      // Give the OS up to 3s to reap.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (countHeadlessChromes() <= baseline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const finalCount = countHeadlessChromes();
      expect(finalCount).toBeLessThanOrEqual(baseline);
      // The specific PID should be gone.
      if (process.platform !== "win32") {
        try {
          execSync(`kill -0 ${pidUnderScope} 2>/dev/null`);
          // If kill -0 succeeded the process is still alive — fail.
          throw new Error(`zombie_chrome_pid=${pidUnderScope}`);
        } catch (e) {
          // Expected: kill -0 errors when process is gone.
          if (e instanceof Error && e.message.startsWith("zombie_chrome_pid")) throw e;
        }
      }
    },
    { timeout: 60_000 },
  );
});
