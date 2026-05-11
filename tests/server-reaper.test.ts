import { afterEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";

let server: RunningUnbrowseServer | null = null;

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
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
    probe.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  if (server) {
    try { await server.close({ shutdownBrowsers: false }); } catch { /* may already be closed by reaper */ }
    server = null;
  }
  delete process.env.UNBROWSE_SERVE_IDLE_MS;
  delete process.env.UNBROWSE_SERVE_IDLE_CHECK_MS;
});

describe("mcp-serve idle reaper", () => {
  it("exits after idle window with no requests and no browse sessions", async () => {
    process.env.UNBROWSE_SERVE_IDLE_MS = "150";
    process.env.UNBROWSE_SERVE_IDLE_CHECK_MS = "50";

    let exitCalls = 0;
    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
      onIdleExit: () => { exitCalls++; },
    });

    // Wait for one health request to bump the activity timestamp.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);

    // Wait long enough for idle window to elapse AND reaper to tick at least once.
    await sleep(400);

    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });

  it("does NOT exit while requests keep arriving", async () => {
    process.env.UNBROWSE_SERVE_IDLE_MS = "200";
    process.env.UNBROWSE_SERVE_IDLE_CHECK_MS = "50";

    let exitCalls = 0;
    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
      onIdleExit: () => { exitCalls++; },
    });

    // Ping every 80ms for 500ms — never lets idle window close.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await fetch(`http://127.0.0.1:${port}/health`);
      await sleep(80);
    }

    expect(exitCalls).toBe(0);
  });

  it("respects UNBROWSE_SERVE_IDLE_MS=0 disable", async () => {
    process.env.UNBROWSE_SERVE_IDLE_MS = "0";
    process.env.UNBROWSE_SERVE_IDLE_CHECK_MS = "50";

    let exitCalls = 0;
    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
      onIdleExit: () => { exitCalls++; },
    });

    await sleep(300);
    expect(exitCalls).toBe(0);
  });
});
