// Falsifying test for the planned "reaper respects in-flight MCP-bridged
// requests" fix.
//
// Today (main): src/server.ts:148-168 reaper only checks
//   - Date.now() - lastActivityTs >= idleMs  (bumped only on `onRequest`)
//   - getBrowseSessionCount() === 0
//
// A long-running MCP-bridged HTTP request (e.g. a 60s capture) bumps
// `lastActivityTs` exactly once at request start. While the request is
// still pending, lastActivityTs goes stale and the reaper decides to
// exit mid-flight. Fastify's `app.close()` blocks on the open socket so
// the symptom is delayed shutdown — but the *decision* to exit happens
// while the request is still in-flight, which is the bug.
//
// Planned fix: track in-flight MCP-bridged requests (header
// `x-unbrowse-mcp-bridged: 1`) via a counter incremented in `onRequest`
// and decremented in `onResponse`. The reaper short-circuits while the
// counter > 0. The contract is observable via the new exported helper
// `getInflightMcpBridgedCount()` from `src/server.ts`.
//
// This test must FAIL on main and PASS after the fix lands. No mocks.
// Real Fastify daemon via startUnbrowseServer with an isolated session
// store so the reaper isn't blocked by rehydrated browse sessions.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import * as serverModule from "../src/server.js";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";

let server: RunningUnbrowseServer | null = null;
let tmpDir: string | null = null;

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    probe.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  if (server) {
    try {
      await server.close({ shutdownBrowsers: false });
    } catch {
      /* may already be closed by reaper */
    }
    server = null;
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = null;
  }
  delete process.env.UNBROWSE_SERVE_IDLE_MS;
  delete process.env.UNBROWSE_SERVE_IDLE_CHECK_MS;
  delete process.env.UNBROWSE_SESSION_STORE;
  delete process.env.MCP_SERVER_MODE;
});

describe("mcp reaper respects in-flight MCP-bridged requests", () => {
  it("does NOT fire onIdleExit while an MCP-bridged request is in-flight", async () => {
    // Isolate browse-session state so the reaper's `getBrowseSessionCount`
    // check doesn't get stuck on rehydrated sessions from ~/.unbrowse.
    tmpDir = mkdtempSync(path.join(tmpdir(), "ub-reaper-inflight-"));
    process.env.UNBROWSE_SESSION_STORE = path.join(tmpDir, "sessions.jsonl");

    process.env.MCP_SERVER_MODE = "1";
    process.env.UNBROWSE_SERVE_IDLE_MS = "1500";
    process.env.UNBROWSE_SERVE_IDLE_CHECK_MS = "500";

    let exitCalled = false;
    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
      onIdleExit: () => {
        exitCalled = true;
      },
    });

    // Contract A — the fix must export `getInflightMcpBridgedCount`.
    // On main this export does not exist; this assertion fails.
    const helper = (serverModule as Record<string, unknown>).getInflightMcpBridgedCount;
    expect(
      typeof helper,
      "src/server.ts must export `getInflightMcpBridgedCount(): number` so the reaper (and tests) can read the in-flight MCP-bridged counter. Not exported on main.",
    ).toBe("function");

    // Contract B — even before the helper is wired in, a long-running
    // MCP-bridged request must not trigger onIdleExit. We open a real
    // TCP connection, send a POST with `x-unbrowse-mcp-bridged: 1` and
    // a Content-Length, then stall on the body so the request stays
    // in-flight across the idle window. After the fix the in-flight
    // counter blocks the reaper; on main the reaper decides to exit
    // (its `app.close()` then blocks on the open socket, which is the
    // observable symptom in production where the next MCP call returns
    // a connect-error and forces a respawn mid-flight).

    const sock = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });

    const headers =
      "POST /v1/version HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "X-Unbrowse-MCP-Bridged: 1\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 32\r\n" +
      "\r\n";
    sock.write(headers);

    // While the request is in-flight, the in-flight counter must be > 0.
    await sleep(200);
    if (typeof helper === "function") {
      const count = (helper as () => number)();
      expect(
        count,
        "while an MCP-bridged request is pending its body, getInflightMcpBridgedCount() must be >= 1",
      ).toBeGreaterThanOrEqual(1);
    }

    // Wait past the idle window plus a reaper tick. On main the reaper
    // would log `[reaper] idle, exiting` and call onIdleExit (deferred
    // by `app.close()` blocking on the socket, but the decision is the
    // bug). After the fix, the in-flight gate keeps onIdleExit from
    // being scheduled at all.
    await sleep(3000);

    expect(
      exitCalled,
      "reaper fired onIdleExit while an MCP-bridged request was still in-flight. The fix must check the in-flight counter (or equivalent gate) before exiting.",
    ).toBe(false);

    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  }, 10_000);
});
