// Phase 2 Day-5 regression — explicit `unbrowse serve` stays alive past
// any MCP-mode 15s reaper window. The serve verb explicitly disables the
// reaper via UNBROWSE_SERVE_IDLE_MS=0.
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default";

describe("unbrowse serve idle=0 regression", () => {
  test("foreground server stays alive past 17s with no requests (would reap at 15s if MCP-mode leaked)", async () => {
    const home = await mkdtemp(join(tmpdir(), "p2-serve-idle-"));
    const port = 17900 + Math.floor(Math.random() * 100);
    const child = spawn(process.execPath, ["src/cli.ts", "serve"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        // Do NOT override UNBROWSE_SERVE_IDLE_MS — the serve verb sets it.
        // Adversarial: set MCP_SERVER_MODE=1 to TRY to trigger the 15s default.
        // The serve verb's UNBROWSE_SERVE_IDLE_MS=0 must override.
        MCP_SERVER_MODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      // Wait for up.
      let up = false;
      const startUp = Date.now();
      while (Date.now() - startUp < 5000) {
        const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (res && res.ok) { up = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);

      // Wait 17 seconds — longer than the MCP-mode 15s reaper but no requests.
      // If unbrowse serve's UNBROWSE_SERVE_IDLE_MS=0 holds, the server is
      // still alive at the end.
      await new Promise((r) => setTimeout(r, 17_000));

      // Verify still alive.
      const stillUp = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(stillUp).not.toBeNull();
      expect(stillUp?.status).toBe(200);

      // Clean shutdown.
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        child.on("exit", () => { clearTimeout(timer); resolve(); });
      });
    } finally {
      try { child.kill("SIGKILL"); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
