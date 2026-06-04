import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";
import { recordSessionCreate, recordSessionDrop } from "../src/api/session-store.js";

let tmp: string;
let storePath: string;
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

beforeEach(async () => {
  // Clear module-level Map state from prior tests (it's a singleton)
  const { __clearBrowseSessionsForTest } = await import("../src/api/routes.js");
  __clearBrowseSessionsForTest();
  tmp = mkdtempSync(path.join(tmpdir(), "unbrowse-rehyd-"));
  storePath = path.join(tmp, "sessions.jsonl");
  process.env.UNBROWSE_SESSION_STORE = storePath;
  process.env.UNBROWSE_SERVE_IDLE_MS = "0"; // disable reaper for these tests
});

afterEach(async () => {
  if (server) {
    try { await server.close({ shutdownBrowsers: false }); } catch { /* noop */ }
    server = null;
  }
  delete process.env.UNBROWSE_SESSION_STORE;
  delete process.env.UNBROWSE_SERVE_IDLE_MS;
  rmSync(tmp, { recursive: true, force: true });
});

describe("browse-session rehydration on server startup", () => {
  it("populates getBrowseSessionCount from sessions.jsonl on cold start", async () => {
    // Seed the file as if a previous daemon had created sessions then died.
    recordSessionCreate({
      sessionId: "sess-1",
      tabId: "tab-1",
      url: "https://example.com/",
      domain: "example.com",
      harActive: true,
      brokerPort: 9223,
      ts: Date.now(),
    });
    recordSessionCreate({
      sessionId: "sess-2",
      tabId: "tab-2",
      url: "https://other.com/",
      domain: "other.com",
      harActive: true,
      brokerPort: 9223,
      ts: Date.now(),
    });

    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
    });

    // /v1/sessions/list returns live sessions but probes Kuri; instead just verify
    // the in-memory count via the reaper export.
    const { getBrowseSessionCount } = await import("../src/api/routes.js");
    expect(getBrowseSessionCount()).toBe(2);
  });

  it("does not rehydrate sessions that were dropped before shutdown", async () => {
    recordSessionCreate({
      sessionId: "sess-A",
      tabId: "tab-A",
      url: "https://example.com/",
      domain: "example.com",
      harActive: true,
      ts: Date.now(),
    });
    recordSessionDrop("sess-A");

    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
    });

    const { getBrowseSessionCount } = await import("../src/api/routes.js");
    expect(getBrowseSessionCount()).toBe(0);
  });

  it("rehydrate is idempotent — calling twice does not double-count", async () => {
    recordSessionCreate({
      sessionId: "sess-idem",
      tabId: "tab-idem",
      url: "https://example.com/",
      domain: "example.com",
      harActive: true,
      ts: Date.now(),
    });

    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
    });

    const { getBrowseSessionCount, rehydrateBrowseSessions } = await import("../src/api/routes.js");
    expect(getBrowseSessionCount()).toBe(1);
    rehydrateBrowseSessions();
    expect(getBrowseSessionCount()).toBe(1);
  });

  it("survives a missing sessions.jsonl file (fresh install)", async () => {
    // No seed — file doesn't exist
    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
    });

    const { getBrowseSessionCount } = await import("../src/api/routes.js");
    expect(getBrowseSessionCount()).toBe(0);
  });
});
