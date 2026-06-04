// FALSIFIER for the stale-global-daemon probe at MCP startup.
//
// Phase 0d removed the :6969 HTTP daemon from this build, but users
// who installed an older `unbrowse` binary globally still have one
// auto-spawning. When both run, kuri state leaks and the browse
// transport wedges permanently — user must /mcp reconnect to recover.
//
// Post-fix: MCP startup probes localhost:6969. If anything answers,
// it surfaces a loud actionable warning with the exact fix command.
// It does NOT auto-kill (the user may be running `unbrowse serve`
// intentionally — that's the env-var escape hatch).
//
// Structural test pins the source; behavioural test runs the probe
// against a real local HTTP server and confirms the warning appears
// on stderr.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mcpSrc = readFileSync(
  join(import.meta.dir, "..", "src", "mcp.ts"),
  "utf8",
);

describe("probeStaleDaemonAndWarn — structural invariants", () => {
  test("function exists, runs from main(), is opt-out-able via env", () => {
    expect(mcpSrc).toMatch(/async function probeStaleDaemonAndWarn/);
    expect(mcpSrc).toContain("await probeStaleDaemonAndWarn()");
    expect(mcpSrc).toContain("UNBROWSE_SKIP_DAEMON_PROBE");
  });

  test("probe is bounded by a configurable timeout (default 250ms)", () => {
    expect(mcpSrc).toMatch(/UNBROWSE_DAEMON_PROBE_TIMEOUT_MS\s*\?\?\s*250/);
    expect(mcpSrc).toContain("AbortController");
  });

  test("warning text contains the actionable pkill command", () => {
    expect(mcpSrc).toContain("pkill -9 -f 'unbrowse|kuri'");
  });

  test("probe does NOT auto-kill (platform-correct: humans decide)", () => {
    // The probe must surface evidence + remediation, never spawn a kill.
    // Pinning the absence of any process.kill / spawnSync('kill', ...)
    // inside the probe scope.
    const probeStart = mcpSrc.indexOf("async function probeStaleDaemonAndWarn");
    const probeEnd = mcpSrc.indexOf("async function main", probeStart);
    expect(probeStart).toBeGreaterThan(0);
    expect(probeEnd).toBeGreaterThan(probeStart);
    const probeBody = mcpSrc.slice(probeStart, probeEnd);
    expect(probeBody).not.toMatch(/process\.kill\b/);
    expect(probeBody).not.toMatch(/spawnSync.*kill/);
    expect(probeBody).not.toMatch(/exec.*pkill/);
  });
});

// Behavioural: import the probe directly and run it against a real
// local server, capturing stderr.
describe("probeStaleDaemonAndWarn — behavioural", () => {
  let server: Server | null = null;
  const stderrChunks: string[] = [];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrChunks.length = 0;
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error monkey-patch for capture
    process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
  });

  afterEach(async () => {
    process.stderr.write = originalStderrWrite;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    delete process.env.UNBROWSE_SKIP_DAEMON_PROBE;
    delete process.env.UNBROWSE_DAEMON_PROBE_URL;
    delete process.env.UNBROWSE_DAEMON_PROBE_TIMEOUT_MS;
  });

  test("emits a warning when something answers at the probe URL", async () => {
    const port = await new Promise<number>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, build: "old" }));
      });
      server.listen(0, () => resolve((server!.address() as { port: number }).port));
    });

    process.env.UNBROWSE_DAEMON_PROBE_URL = `http://localhost:${port}/health`;
    process.env.UNBROWSE_DAEMON_PROBE_TIMEOUT_MS = "500";

    // Re-import to pick up the env. The probe is not exported, so we
    // exercise it via the main module's exposed surface by calling it
    // dynamically.
    const { probeForTests } = await loadProbe();
    await probeForTests();

    const out = stderrChunks.join("");
    expect(out).toContain("WARN");
    expect(out).toContain("localhost:6969");
    expect(out).toContain("pkill");
  });

  test("emits no warning when nothing answers (clean state)", async () => {
    // Use a port we know is unused (random high port, never bound).
    process.env.UNBROWSE_DAEMON_PROBE_URL = "http://localhost:1/health";
    process.env.UNBROWSE_DAEMON_PROBE_TIMEOUT_MS = "150";

    const { probeForTests } = await loadProbe();
    await probeForTests();

    const out = stderrChunks.join("");
    expect(out).not.toContain("WARN");
  });

  test("env opt-out skips the probe entirely", async () => {
    process.env.UNBROWSE_SKIP_DAEMON_PROBE = "1";
    process.env.UNBROWSE_DAEMON_PROBE_URL = "http://localhost:65535/health";

    const { probeForTests } = await loadProbe();
    await probeForTests();

    const out = stderrChunks.join("");
    expect(out).not.toContain("WARN");
  });
});
// Import the exported probe directly. mcp.ts also calls main() on
// import (it's the entrypoint), but main() awaits stdin which never
// arrives in the test runner — the import resolves once telemetry
// boot completes and the function is callable.
async function loadProbe(): Promise<{ probeForTests: () => Promise<void> }> {
  const mod = await import("../src/mcp.js");
  return { probeForTests: mod.probeStaleDaemonAndWarn };
}
