// Regression test for the workbench daemon-port collision bug.
//
// Before the fix: proxy.ts called spawnChild(..., {}, side) so candidate and
// baseline children inherited the SAME UNBROWSE_URL from the proxy's own
// env (defaulting to localhost:6969). Each child's mcp.ts then asked
// ensureLocalServer to bind a Fastify daemon at the SAME port. Whichever
// side started first "won"; the other silently re-used the first side's
// daemon. _workbench_delta said "identical" because both sides were the
// same upstream binary.
//
// After the fix: proxy.ts reads UNBROWSE_URL_CANDIDATE and
// UNBROWSE_URL_BASELINE from its own env (with non-conflicting defaults)
// and passes them per-side. Each child binds its own daemon. The diff
// reflects real upstream differences.
//
// This test uses the env-url-echo stub: it responds with its UNBROWSE_URL
// in `result.url`. We send one tools/call, read the merged response, and
// assert the live (candidate) side echoed the candidate URL we configured.
// We also assert structural_diff_summary reports a value difference at the
// `url` key — proof that baseline saw a DIFFERENT UNBROWSE_URL.

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const PROXY_PATH = resolve(import.meta.dir, "..", "bin", "proxy.ts");
const STUB_PATH = resolve(import.meta.dir, "fixtures", "env-url-echo-stub.ts");

interface MergedResponse {
  jsonrpc: string;
  id: number | string;
  result?: { url?: string; method?: string };
  _workbench_delta?: {
    live: "candidate" | "baseline";
    candidate: { ms: number; bytes: number };
    baseline: { ms: number; bytes: number };
    diff: {
      bytes_diff: number;
      ms_diff: number;
      structural_diff_summary: string;
    };
  };
}

async function callOnce(env: NodeJS.ProcessEnv, request: Record<string, unknown>): Promise<MergedResponse> {
  const proxy = spawn("bun", ["run", PROXY_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let buf = "";
    proxy.stdout.setEncoding("utf8");
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", () => {});

    const responses: MergedResponse[] = [];
    proxy.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            // ignore non-JSON
          }
        }
        idx = buf.indexOf("\n");
      }
    });

    // Wait briefly for the children to come up before sending. The proxy
    // spawns them synchronously at module load; 200 ms is plenty for a
    // bun-run stub that exits immediately on EOF.
    await new Promise((r) => setTimeout(r, 200));
    proxy.stdin.write(JSON.stringify(request) + "\n");

    const deadline = Date.now() + 5000;
    while (responses.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (responses.length === 0) {
      throw new Error("no response from proxy within 5s");
    }
    return responses[0]!;
  } finally {
    try { proxy.kill("SIGTERM"); } catch { /* best-effort */ }
  }
}

describe("per-side UNBROWSE_URL", () => {
  test("candidate and baseline children get distinct UNBROWSE_URL env vars", async () => {
    const merged = await callOnce(
      {
        UNBROWSE_BIN_CANDIDATE: `bun run ${STUB_PATH}`,
        UNBROWSE_BIN_BASELINE: `bun run ${STUB_PATH}`,
        UNBROWSE_URL_CANDIDATE: "http://127.0.0.1:17770",
        UNBROWSE_URL_BASELINE: "http://127.0.0.1:17771",
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "noop", arguments: {} },
      },
    );

    // Live side is the candidate by default. Its result should reflect the
    // candidate UNBROWSE_URL we configured — proof the proxy passed it down.
    expect(merged.result?.url).toBe("http://127.0.0.1:17770");

    // _workbench_delta must be present (this is the merged-response contract).
    expect(merged._workbench_delta).toBeDefined();
    expect(merged._workbench_delta?.live).toBe("candidate");

    // Both sides responded. structural_diff_summary should report a value
    // difference at the `url` key (candidate=17770, baseline=17771). If
    // it says "identical", per-side env didn't propagate.
    const summary = merged._workbench_delta?.diff.structural_diff_summary ?? "";
    expect(summary).not.toBe("identical");
    expect(summary).toContain("url");
  });

  test("default per-side URLs are distinct when env vars not set", async () => {
    const merged = await callOnce(
      {
        UNBROWSE_BIN_CANDIDATE: `bun run ${STUB_PATH}`,
        UNBROWSE_BIN_BASELINE: `bun run ${STUB_PATH}`,
        // Deliberately do NOT set UNBROWSE_URL_CANDIDATE / _BASELINE.
        // The proxy's hardcoded defaults must be different from each other.
        // Also clear any inherited UNBROWSE_URL so it doesn't leak through.
        UNBROWSE_URL: "",
        UNBROWSE_URL_CANDIDATE: "",
        UNBROWSE_URL_BASELINE: "",
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "noop", arguments: {} },
      },
    );

    const candidateUrl = merged.result?.url ?? "";
    expect(candidateUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Distinct from baseline by virtue of distinct ports → diff is not "identical".
    const summary = merged._workbench_delta?.diff.structural_diff_summary ?? "";
    expect(summary).not.toBe("identical");
  });
});
