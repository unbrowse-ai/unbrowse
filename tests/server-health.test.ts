import { afterEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { CODE_HASH, PACKAGE_VERSION } from "../src/version.js";
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

afterEach(async () => {
  await server?.close({ shutdownBrowsers: false });
  server = null;
});

describe("server health", () => {
  it("reports package version alongside the code hash", async () => {
    const port = await getFreePort();
    server = await startUnbrowseServer({
      host: "127.0.0.1",
      port,
      logger: false,
      scheduleVerification: false,
    });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);

    const body = await res.json() as {
      status?: string;
      package_version?: string;
      code_hash?: string;
      pid?: number;
    };
    expect(body.status).toBe("ok");
    expect(body.package_version).toBe(PACKAGE_VERSION);
    expect(body.code_hash).toBe(CODE_HASH);
    expect(body.pid).toBe(process.pid);
  });
});
