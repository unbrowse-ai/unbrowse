// Phase 2 end-to-end integration probe across a real MCP stdio session.
// Current contract: MCP serves tools in-process. A real tool call must work
// without auto-spawning the old local HTTP daemon.
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("Phase 2 end-to-end MCP flow", () => {
  test("MCP stdio -> tool call works -> old daemon port stays closed", async () => {
    const home = await mkdtemp(join(tmpdir(), "p2-e2e-"));
    const port = 18000 + Math.floor(Math.random() * 500);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      UNBROWSE_URL: `http://127.0.0.1:${port}`,
      UNBROWSE_PID_FILE: join(home, "pidfile"),
    };
    delete env.UNBROWSE_NO_SWEEP;

    const mcp = spawn(process.execPath, ["src/mcp.ts"], {
      cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    mcp.stdout?.on("data", (d) => (stdout += d.toString()));
    mcp.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      // Step 1: MCP initialize handshake.
      mcp.stdin?.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p2-e2e", version: "0" } },
      }) + "\n");
      mcp.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // Step 1b: real tool call through the stdio MCP surface.
      mcp.stdin?.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      }) + "\n");

      // Step 2: wait for the tool response on stdout.
      const start = Date.now();
      let gotToolResponse = false;
      while (Date.now() - start < 8000) {
        const lines = stdout.split("\n").filter(Boolean);
        gotToolResponse = lines.some((line) => {
          try {
            const msg = JSON.parse(line);
            return msg.id === 2 && !!msg.result;
          } catch {
            return false;
          }
        });
        if (gotToolResponse) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(gotToolResponse).toBe(true);

      // Step 3: the retired auto-spawn daemon must not be listening.
      const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(res).toBeNull();

      // Step 4: close stdin and verify the stdio process exits.
      mcp.stdin?.end();

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { mcp.kill("SIGKILL"); resolve(); }, 5000);
        mcp.on("exit", () => { clearTimeout(timer); resolve(); });
      });
      expect(stderr).not.toContain("starting server on");
    } finally {
      try { mcp.kill("SIGKILL"); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 25_000);
});
