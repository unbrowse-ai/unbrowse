import { afterEach, describe, expect, it } from "bun:test";
import { createConnection } from "node:net";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";

let server: RunningUnbrowseServer | null = null;
afterEach(async () => {
  if (server) await server.close({ shutdownBrowsers: false }).catch(() => {});
  server = null;
  delete process.env.UNBROWSE_SERVE_IDLE_MS;
  delete process.env.UNBROWSE_SERVE_IDLE_CHECK_MS;
});

describe("idle reaper shared request lifecycle", () => {
  it("does not close on a long ordinary HTTP request", async () => {
    process.env.UNBROWSE_SERVE_IDLE_MS = "100";
    process.env.UNBROWSE_SERVE_IDLE_CHECK_MS = "20";
    let exited = false;
    server = await startUnbrowseServer({
      host: "127.0.0.1", port: 0, logger: false, scheduleVerification: false,
      onIdleExit: () => { exited = true; },
    });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      "POST /v1/version HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${address.port}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 32\r\n\r\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(exited).toBe(false);
    socket.destroy();
  }, 5_000);
});
