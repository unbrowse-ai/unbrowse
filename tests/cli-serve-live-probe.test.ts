// Phase 2 Day-4 luminary — proves `unbrowse serve` actually serves.
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default";

describe("unbrowse serve live probe", () => {
  test("server responds to a real HTTP request and cleans up on SIGTERM", async () => {
    const home = await mkdtemp(join(tmpdir(), "p2-serve-live-"));
    // Pick a port in the 16000-17000 range to avoid colliding with the
    // default 6969 or any local dev server.
    const port = 16000 + Math.floor(Math.random() * 1000);

    const child = spawn(process.execPath, ["src/cli.ts", "serve"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        UNBROWSE_SERVE_IDLE_MS: "0",
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_SKIP_TOS_CHECK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      // Poll for the listener being up. 10-second budget — Fastify bootstrap
      // + route registration can take a few seconds cold.
      const start = Date.now();
      let up = false;
      while (Date.now() - start < 10_000) {
        if (child.exitCode !== null) break;
        const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (res && res.ok) {
          up = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      expect(up).toBe(true);

      // Confirm the route actually returns 200 with a real body.
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      // Clean shutdown via SIGTERM.
      child.kill("SIGTERM");
      const exitCode = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(-1);
        }, 5000);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          // Node reports null code + SIGTERM signal for graceful term.
          resolve(code ?? (signal === "SIGTERM" ? 143 : -1));
        });
      });
      expect([0, 143]).toContain(exitCode);

      // Listener should be gone after shutdown.
      const after = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(after).toBeNull();
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
