import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export type StartedBackend = {
  baseUrl: string;
  close: () => Promise<void>;
};

const E2E_PROJECT_NAME = "unbrowse-openclaw-e2e";
const E2E_COMPOSE_FILE = fileURLToPath(new URL("./reverse-engineer.e2e.compose.yml", import.meta.url));
const DEFAULT_BASE_URL = "http://127.0.0.1:4112";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function looksLikeReverseEngineerRepo(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, "Dockerfile")) &&
    existsSync(join(dir, "src"))
  );
}

function findReverseEngineerRepo(): string {
  const explicit = process.env.E2E_BACKEND_PATH;
  if (explicit) return explicit;

  const candidates: Array<{ path: string; score: number }> = [];

  // Common local-dev layouts (backend checked out alongside this repo).
  for (const p of [
    resolve(REPO_ROOT, "..", "reverse-engineer"),
    resolve(REPO_ROOT, "..", "..", "reverse-engineer"),
  ]) {
    if (looksLikeReverseEngineerRepo(p)) candidates.push({ path: p, score: statSync(p).mtimeMs });
  }

  // Codex worktrees layout: ~/.codex/worktrees/<id>/reverse-engineer
  const codexWorktrees = resolve(homedir(), ".codex", "worktrees");
  if (existsSync(codexWorktrees)) {
    for (const entry of readdirSync(codexWorktrees, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(codexWorktrees, entry.name, "reverse-engineer");
      if (looksLikeReverseEngineerRepo(p)) candidates.push({ path: p, score: statSync(p).mtimeMs });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]?.path;
  if (best) return best;

  throw new Error(
    [
      "reverse-engineer backend repo not found.",
      "Set E2E_BACKEND_PATH=/path/to/reverse-engineer or E2E_REAL_BACKEND_URL=http://127.0.0.1:4112.",
      `Searched: ${resolve(REPO_ROOT, "..", "reverse-engineer")}, ${resolve(REPO_ROOT, "..", "..", "reverse-engineer")}, ${codexWorktrees}/*/reverse-engineer`,
    ].join(" "),
  );
}

async function waitForOk(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (resp.ok) return;
      lastErr = new Error(`Non-200 from ${url}: ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(300);
  }
  throw new Error(`Backend not ready: ${url}. Last error: ${(lastErr as any)?.message ?? String(lastErr)}`);
}

async function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function tryHealthy(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(800) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function tryMarketplaceReady(baseUrl: string): Promise<boolean> {
  try {
    // Exercises DB-backed code paths so we don't "attach" to a backend with a half-applied schema.
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/marketplace/skills?limit=1`, { signal: AbortSignal.timeout(1200) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function startBackendDockerCompose(backendPath: string): Promise<void> {
  // Run a dedicated, isolated stack for tests (separate containers/volume and a non-default port).
  // `--build` is important: backend changes are frequent and we want tests to reflect reality.
  const composeDir = dirname(E2E_COMPOSE_FILE);

  const dockerEnv: NodeJS.ProcessEnv = { E2E_BACKEND_PATH: backendPath };

  // Ensure a clean DB (and ensure postgres init scripts run) when we have to start the stack.
  // This avoids partial-schema states where later migrations never ran.
  try {
    await run(
      "docker",
      ["compose", "-f", E2E_COMPOSE_FILE, "-p", E2E_PROJECT_NAME, "down", "-v", "--remove-orphans"],
      composeDir,
      dockerEnv,
    );
  } catch {
    // ignore
  }

  await run("docker", ["compose", "-f", E2E_COMPOSE_FILE, "-p", E2E_PROJECT_NAME, "up", "-d", "--build"], composeDir, dockerEnv);
  await waitForOk(`${DEFAULT_BASE_URL}/health`, 180_000);
}

async function startBackendPnpmDev(backendPath: string): Promise<{ child: ReturnType<typeof spawn>; baseUrl: string }> {
  const port = 4112;
  if (!existsSync(join(backendPath, ".env"))) {
    throw new Error(`Backend .env not found at ${join(backendPath, ".env")}. Create it or use E2E_BACKEND_START=docker.`);
  }
  const child = spawn("pnpm", ["-s", "dev"], {
    cwd: backendPath,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      VECTOR_DB_KEEPALIVE_MINUTES: "0",
    },
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForOk(`${baseUrl}/health`, 90_000);
  return { child, baseUrl };
}

/**
 * Start (or attach to) the real reverse-engineer backend.
 *
 * Env:
 * - E2E_REAL_BACKEND_URL: use an existing backend URL (no start/stop)
 * - E2E_BACKEND_PATH: path to reverse-engineer repo (optional: auto-discovered for Codex worktrees)
 * - E2E_BACKEND_START: "docker" (default) | "pnpm" | "none"
 * - E2E_BACKEND_TEARDOWN: "down" to `docker compose down` on close (only if we started it)
 */
export async function startRealBackend(): Promise<StartedBackend> {
  const baseUrlFromEnv = process.env.E2E_REAL_BACKEND_URL?.replace(/\/$/, "");
  if (baseUrlFromEnv) {
    await waitForOk(`${baseUrlFromEnv}/health`, 60_000);
    return { baseUrl: baseUrlFromEnv, close: async () => {} };
  }

  const baseUrl = DEFAULT_BASE_URL;
  const startMode = (process.env.E2E_BACKEND_START ?? "docker").toLowerCase();
  if ((await tryHealthy(baseUrl)) && (await tryMarketplaceReady(baseUrl))) {
    return { baseUrl, close: async () => {} };
  }

  const backendPath = findReverseEngineerRepo();
  if (!existsSync(backendPath)) {
    throw new Error(`Real backend path not found: ${backendPath}`);
  }

  if (startMode === "none") {
    throw new Error(`Backend not running at ${baseUrl} and E2E_BACKEND_START=none`);
  }

  if (startMode === "docker") {
    await startBackendDockerCompose(backendPath);
    const teardown = (process.env.E2E_BACKEND_TEARDOWN ?? "").toLowerCase() === "down";
    return {
      baseUrl,
      close: async () => {
        if (!teardown) return;
        const composeDir = dirname(E2E_COMPOSE_FILE);
        await run("docker", ["compose", "-f", E2E_COMPOSE_FILE, "-p", E2E_PROJECT_NAME, "down", "-v", "--remove-orphans"], composeDir, {
          E2E_BACKEND_PATH: backendPath,
        });
      },
    };
  }

  if (startMode === "pnpm") {
    const started = await startBackendPnpmDev(backendPath);
    return {
      baseUrl: started.baseUrl,
      close: async () => {
        started.child.kill("SIGTERM");
        await delay(500);
        if (!started.child.killed) started.child.kill("SIGKILL");
      },
    };
  }

  throw new Error(`Unknown E2E_BACKEND_START=${startMode}`);
}

export async function withBackend<T>(fn: (backend: StartedBackend) => Promise<T>): Promise<T> {
  const backend = await startRealBackend();
  try {
    return await fn(backend);
  } finally {
    await backend.close();
  }
}
