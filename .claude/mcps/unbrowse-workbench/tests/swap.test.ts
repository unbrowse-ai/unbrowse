// Day-4 Luminaries: falsifiable signal over Day-3 SIGHUP swap.
// Real-runtime: spawn proxy.ts as a real child process with TWO stub
// upstream binaries (one candidate, one baseline). Send a tools/call, send
// SIGHUP, send another tools/call. Assert _workbench_delta.live flips.
// No mocks. http.createServer not needed; the upstreams ARE child processes.

import { describe, test, expect, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const PROXY_PATH = resolve(import.meta.dir, "..", "bin", "proxy.ts");


async function callProxy(req: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{
  proxy: ReturnType<typeof spawn>;
  responses: Record<string, unknown>[];
}> {
  const proxy = spawn("bun", ["run", PROXY_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: Record<string, unknown>[] = [];
  let buf = "";
  proxy.stdout!.setEncoding("utf8");
  proxy.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          responses.push(JSON.parse(line));
        } catch (_) {
          // skip; non-JSON output
        }
      }
      idx = buf.indexOf("\n");
    }
  });
  proxy.stderr!.setEncoding("utf8");
  proxy.stderr!.on("data", () => {}); // drain
  proxy.stdin!.write(JSON.stringify(req) + "\n");
  return { proxy, responses };
}

describe("SIGHUP swap", () => {
  let proxy: ReturnType<typeof spawn> | null = null;

  afterAll(() => {
    if (proxy && !proxy.killed) {
      try {
        proxy.kill("SIGTERM");
      } catch (_) {}
    }
  });

  test("SIGHUP flips _workbench_delta.live between candidate and baseline", async () => {
    const stubPath = resolve(import.meta.dir, "fixtures", "upstream-stub.ts");
    const env = {
      UNBROWSE_BIN_CANDIDATE: `bun run ${stubPath} candidate`,
      UNBROWSE_BIN_BASELINE: `bun run ${stubPath} baseline`,
    };

    const { proxy: p, responses } = await callProxy(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } },
      env,
    );
    proxy = p;

    // Wait up to 3s for the first response.
    const t0 = Date.now();
    while (responses.length < 1 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(responses.length).toBeGreaterThanOrEqual(1);

    const first = responses[0] as { _workbench_delta?: { live?: string } };
    expect(first._workbench_delta).toBeDefined();
    const liveBefore = first._workbench_delta!.live;
    expect(["candidate", "baseline"]).toContain(liveBefore);

    // Send SIGHUP to the proxy.
    proxy!.kill("SIGHUP");
    await new Promise((r) => setTimeout(r, 200));

    // Second tools/call.
    proxy!.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } }) + "\n",
    );

    const t1 = Date.now();
    while (responses.length < 2 && Date.now() - t1 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(responses.length).toBeGreaterThanOrEqual(2);
    const second = responses[1] as { _workbench_delta?: { live?: string } };
    expect(second._workbench_delta).toBeDefined();
    const liveAfter = second._workbench_delta!.live;
    expect(liveAfter).not.toBe(liveBefore);
  });
});
