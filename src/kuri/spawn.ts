/**
 * Shared Kuri auto-spawn for the executor's runtime context.
 *
 * The CLI's `unbrowse fetch` command calls `ensureKuriReachable` (cli.ts:186)
 * which probes /health and spawns the bundled Kuri binary if absent. The
 * unbrowse server's embedded Kuri runs on port 6969 WITHOUT
 * /v1/sandbox/replay; the auto-spawned standalone Kuri runs on port 8080
 * WITH the sandbox endpoint. Phase D's 5xx → ssr-fastpath fallback (and
 * Phase B-wire's capture-time fallback) need the sandbox-capable Kuri.
 *
 * This is the non-die variant of cli.ts:186 — returns true on success,
 * false on failure (no process.exit). Production code paths can call this
 * before invoking trySsrFastPathOnBlock.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  firstExisting,
  kuriBinaryName,
  kuriVendorCandidatePaths,
} from "./resolve-paths.js";

export async function ensureKuriSandboxReachable(kuriBase = "http://127.0.0.1:8080"): Promise<boolean> {
  const probeOnce = async () => {
    try {
      const h = await fetch(`${kuriBase}/health`, { signal: AbortSignal.timeout(800) });
      return h.ok;
    } catch { return false; }
  };
  if (await probeOnce()) return true;

  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.UNBROWSE_KURI_BIN,
      process.env.KURI_BIN,
      join(process.cwd(), "submodules", "kuri", "zig-out", "bin", kuriBinaryName()),
      ...kuriVendorCandidatePaths({ execDir: dirname(process.execPath), moduleDir }),
      "/opt/homebrew/bin/kuri",
      "/usr/local/bin/kuri",
    ];

    const kuriBin = firstExisting(candidates, existsSync);
    if (!kuriBin) return false;
    const expectedPort = (() => {
      try { const u = new URL(kuriBase); return u.port || "8080"; } catch { return "8080"; }
    })();
    const logFd = openSync(join(tmpdir(), "kuri.log"), "a");
    const child = spawn(kuriBin, [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PORT: expectedPort, HOST: "127.0.0.1" },
    });
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once("error", resolve);
      setTimeout(() => resolve(null), 100);
    });
    if (spawnError) return false;
    child.unref();

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probeOnce()) return true;
    }
    return false;
  } catch {
    return false;
  }
}
