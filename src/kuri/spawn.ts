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
export async function ensureKuriSandboxReachable(kuriBase = "http://127.0.0.1:8080"): Promise<boolean> {
  const probeOnce = async () => {
    try {
      const h = await fetch(`${kuriBase}/health`, { signal: AbortSignal.timeout(800) });
      return h.ok;
    } catch { return false; }
  };
  if (await probeOnce()) return true;

  try {
    const { spawn } = await import("node:child_process");
    const { existsSync, openSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const kuriTarget = (() => {
      if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
      if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
      if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
      if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
      if (process.platform === "win32" && process.arch === "x64") return "win-x64";
      return null;
    })();
    const kuriBinName = process.platform === "win32" ? "kuri.exe" : "kuri";

    const candidates = [
      process.env.UNBROWSE_KURI_BIN,
      process.env.KURI_BIN,
      join(process.cwd(), "submodules/kuri/zig-out/bin/kuri"),
      kuriTarget ? join(moduleDir, "../vendor/kuri", kuriTarget, kuriBinName) : undefined,
      kuriTarget ? join(moduleDir, "../packages/skill/vendor/kuri", kuriTarget, kuriBinName) : undefined,
      "/opt/homebrew/bin/kuri",
      "/usr/local/bin/kuri",
    ].filter((p): p is string => !!p && existsSync(p));

    if (candidates.length === 0) return false;

    const kuriBin = candidates[0];
    const expectedPort = (() => {
      try { const u = new URL(kuriBase); return u.port || "8080"; } catch { return "8080"; }
    })();
    const logFd = openSync("/tmp/kuri.log", "a");
    const child = spawn(kuriBin, [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PORT: expectedPort, HOST: "127.0.0.1" },
    });
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
