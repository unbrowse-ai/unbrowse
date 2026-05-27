/**
 * W10-B — v7 CLI eval state-surface tests.
 *
 * Covers: `eval version`, `eval sessions`, `eval status`, `eval stats`.
 *
 * Hard invariant (load-bearing — see CLAUDE.md "No stubs, no dummy data"
 * and the W3 secret-redaction rule): the wallet PRIVATE key (`walletSecret`,
 * `privateKey`, `seed`) MUST NEVER appear in ANY handler's stdout/stderr.
 * Tests 1-4 cover the structural shape per handler; the negative
 * regression-guard at the bottom sweeps every handler's output for
 * forbidden keys and substrings.
 *
 * Backend tests (`stats`) skip when `UNBROWSE_STATS_OFFLINE === '1'` — no
 * mocks for real backends per repo convention.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");
const SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

/**
 * Forbidden-substring sweep over a single RunResult. The wallet seed is
 * 32 bytes; if any handler ever spilled it as hex it would be 64 hex
 * chars labeled with a secret-shaped key. We assert on the KEY NAMES
 * (the parse-able JSON shape) rather than the value (which we cannot
 * know without reading the keychain).
 */
function assertNoSecretLeak(res: RunResult, ctx: string): void {
  const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
  const forbidden = ["walletsecret", "privatekey", "\"seed\"", "privkey", "wallet_secret", "private_key"];
  for (const f of forbidden) {
    if (combined.includes(f)) {
      throw new Error(
        `[${ctx}] forbidden secret-shaped token "${f}" appeared in handler output:\nstdout=${res.stdout}\nstderr=${res.stderr}`,
      );
    }
  }
}

describe("v7-cli eval version", () => {
  it("emits JSON with version + buildSha + 64-char hex walletPubkey, NO walletSecret", async () => {
    const res = await runCli(["eval", "version", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.subcommand).toBe("eval version");
    expect(out.covenant_kind).toBe("observe_version");
    expect(typeof out.version).toBe("string");
    expect((out.version as string).length).toBeGreaterThan(0);
    expect(typeof out.buildSha).toBe("string");
    expect(typeof out.walletPubkey).toBe("string");
    expect((out.walletPubkey as string)).toMatch(/^[0-9a-f]{64}$/);
    expect(out.signatureScheme).toBe("ed25519-v7.0");
    // Negative shape — no key shaped like a private key surface.
    expect("walletSecret" in out).toBe(false);
    expect("privateKey" in out).toBe(false);
    expect("seed" in out).toBe(false);
    assertNoSecretLeak(res, "eval version");
  }, 15_000);
});

describe("v7-cli eval sessions", () => {
  it("lists session files; shows alive=false when target unreachable", async () => {
    if (!existsSync(SESSIONS_DIR)) {
      await mkdir(SESSIONS_DIR, { recursive: true });
    }
    // Write a deterministic ghost session — a chromePid that cannot be
    // alive (PID 1 is init/launchd and the OS will block kill(0) for
    // non-owners; we use a huge synthetic pid that will not exist).
    const ghostPath = join(SESSIONS_DIR, "ghost-w10b.json");
    const ghost = {
      sessionId: "ghost-w10b",
      contextId: "ctx-ghost",
      targetId: "tgt-ghost",
      chromeWsUrl: "ws://127.0.0.1:1/devtools/browser/ghost",
      chromePid: 2_147_483_646, // INT32_MAX-1, not a live pid
      createdAt: Date.now(),
    };
    await writeFile(ghostPath, JSON.stringify(ghost, null, 2) + "\n");

    try {
      const res = await runCli(["eval", "sessions", "--json"]);
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(out.ok).toBe(true);
      expect(out.subcommand).toBe("eval sessions");
      expect(out.covenant_kind).toBe("observe_sessions");
      expect(Array.isArray(out.sessions)).toBe(true);
      const sessions = out.sessions as Array<Record<string, unknown>>;
      const ghostRow = sessions.find((r) => r.sessionId === "ghost-w10b");
      expect(ghostRow).toBeDefined();
      expect(ghostRow!.alive).toBe(false);
      assertNoSecretLeak(res, "eval sessions");
    } finally {
      // Cleanup
      try {
        await rm(ghostPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }, 15_000);
});

describe("v7-cli eval status", () => {
  it("returns valid JSON shape with version + walletPubkey + sessions array, even at zero", async () => {
    const res = await runCli(["eval", "status", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.subcommand).toBe("eval status");
    expect(out.covenant_kind).toBe("observe_status");
    expect(typeof out.version).toBe("string");
    expect(typeof out.buildSha).toBe("string");
    expect(typeof out.walletPubkey).toBe("string");
    expect((out.walletPubkey as string)).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof out.chromeProcesses).toBe("number");
    expect(Array.isArray(out.sessions)).toBe(true);
    expect("walletSecret" in out).toBe(false);
    expect("privateKey" in out).toBe(false);
    expect("seed" in out).toBe(false);
    assertNoSecretLeak(res, "eval status");
  }, 15_000);
});

describe("v7-cli eval stats", () => {
  const OFFLINE = process.env.UNBROWSE_STATS_OFFLINE === "1";

  it.if(!OFFLINE)("handles real backend response + honors --fresh flag", async () => {
    const res = await runCli(["eval", "stats", "--json", "--fresh"]);
    // Exit 0 on 2xx, 1 on non-2xx — both are honest answers. We assert
    // shape on the JSON envelope, not the upstream content.
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out.subcommand).toBe("eval stats");
    expect(out.covenant_kind).toBe("observe_stats");
    expect(out.fresh).toBe(true);
    expect(typeof out.api_base).toBe("string");
    expect(typeof out.status_code).toBe("number");
    // summary present even on error path (the backend may return JSON
    // with an "error" key)
    expect("summary" in out).toBe(true);
    assertNoSecretLeak(res, "eval stats");
  }, 30_000);

  it.if(OFFLINE)("skipped in offline mode (UNBROWSE_STATS_OFFLINE=1)", () => {
    expect(true).toBe(true);
  });
});

describe("v7-cli eval — regression guard: no secret leaks across handlers", () => {
  it("scans stdout+stderr of every eval state handler for forbidden secret-shaped keys", async () => {
    const variants: Array<[string, string[]]> = [
      ["eval version", ["eval", "version", "--json"]],
      ["eval sessions", ["eval", "sessions", "--json"]],
      ["eval status", ["eval", "status", "--json"]],
    ];
    for (const [label, args] of variants) {
      const res = await runCli(args);
      assertNoSecretLeak(res, label);
    }
    // stats — only if online; the negative guard still applies.
    if (process.env.UNBROWSE_STATS_OFFLINE !== "1") {
      const res = await runCli(["eval", "stats", "--json"]);
      assertNoSecretLeak(res, "eval stats");
    }
  }, 60_000);
});
