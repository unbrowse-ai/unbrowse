// Phase 2 Day-3: MCP process-level resilience guards.
//
// Background: docs/carousell-shoes-mcp-fix-plan.md documented an
// MCP-server-death where a bad handler took the whole process down via
// `MCP error -32000: Connection closed`, killing all 33 tools. The
// dispatcher try/catch at src/mcp.ts handleRequest and the stdio loop's
// catch around handleRequest cover sync throws and JSON.parse failures —
// but async throws from fire-and-forget .then chains (post-spawn in
// ensureServerReady) or emitter callbacks bypass both and crash the
// process via the default Bun/node fail-fast.
//
// The fix installs process.on("uncaughtException") and
// process.on("unhandledRejection") inside main() before createInterface.
// This test pins that behavior — both that the source has the handlers
// (structural) and that a spawned MCP process starts cleanly and lists
// tools (smoke).
//
// Honest scope: we don't manufacture a way to trigger an unhandled
// rejection from inside a tool call here. That belongs to the
// agent-experience harness (X5+) per CLAUDE.md harness-collects rule.
// No mocks. Real spawn, real source.

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const MCP_ENTRY = path.join(REPO_ROOT, "src", "mcp.ts");

function pickPort(): number {
  return 17970 + Math.floor(Math.random() * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mcp process-level resilience guards", () => {
  test("source installs uncaughtException + unhandledRejection handlers in main()", () => {
    const src = readFileSync(MCP_ENTRY, "utf-8");

    // Both names must appear at least once.
    const uncaught = src.match(/uncaughtException/g) ?? [];
    const unhandled = src.match(/unhandledRejection/g) ?? [];
    expect(uncaught.length).toBeGreaterThanOrEqual(1);
    expect(unhandled.length).toBeGreaterThanOrEqual(1);

    // The handlers must NOT call process.exit — the entire point is to
    // keep the process alive. Locate the guard block and assert it does
    // not contain process.exit. We scope to the function body of main().
    const mainIdx = src.indexOf("async function main(");
    expect(mainIdx).toBeGreaterThan(-1);
    // Crude but adequate: the guards live in the first ~3KB of main()
    // (we install them right after the banner, before createInterface).
    const mainHead = src.slice(mainIdx, mainIdx + 3000);
    expect(mainHead).toContain("uncaughtException");
    expect(mainHead).toContain("unhandledRejection");
    expect(mainHead).toContain("UNBROWSE_TEST_FAIL_FAST");

    // Carve out the guard region between the banner and createInterface.
    const banner = mainHead.indexOf("starting stdio server");
    const ci = mainHead.indexOf("createInterface");
    expect(banner).toBeGreaterThan(-1);
    expect(ci).toBeGreaterThan(banner);
    const guardRegion = mainHead.slice(banner, ci);
    // No process.exit in the guard region. Default fail-fast off-switch
    // must not be re-implemented as a hard kill.
    expect(guardRegion).not.toContain("process.exit");
  });

  test(
    "spawned MCP returns tools/list and remains alive (smoke)",
    async () => {
      const runDir = mkdtempSync(path.join(tmpdir(), "unbrowse-resilience-"));
      const port = pickPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        ...process.env,
        UNBROWSE_URL: baseUrl,
        UNBROWSE_RUN_DIR: runDir,
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_TOS_ACCEPTED: "1",
        MCP_SERVER_MODE: "1",
        // Leave UNBROWSE_TEST_FAIL_FAST UNSET so the handlers are installed.
      };

      const proc = spawn("bun", [MCP_ENTRY], {
        cwd: REPO_ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr.on("data", (b) => { stderr += b.toString(); });
      let stdout = "";
      proc.stdout.on("data", (b) => { stdout += b.toString(); });

      try {
        // initialize, then tools/list.
        proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "0" }, capabilities: {} },
        }) + "\n");
        proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/list",
        }) + "\n");

        // Wait up to 15s for both responses to land.
        const deadline = Date.now() + 15_000;
        let listResponse: any = null;
        while (Date.now() < deadline && !listResponse) {
          await sleep(100);
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg && msg.id === 2 && msg.result) {
                listResponse = msg;
                break;
              }
            } catch {
              // partial line, keep waiting
            }
          }
        }

        expect(
          listResponse,
          `tools/list never returned within 15s. stderr=${stderr.slice(-2000)} stdout=${stdout.slice(-2000)}`,
        ).not.toBeNull();
        expect(Array.isArray(listResponse.result?.tools)).toBe(true);
        expect(listResponse.result.tools.length).toBeGreaterThan(0);

        // Process must still be alive (we have not killed or EOF'd it).
        expect(proc.exitCode).toBeNull();
        expect(proc.killed).toBe(false);
      } finally {
        try { proc.stdin.end(); } catch {}
        try { proc.kill("SIGKILL"); } catch {}
        try { rmSync(runDir, { recursive: true, force: true }); } catch {}
      }
    },
    25_000,
  );
});
