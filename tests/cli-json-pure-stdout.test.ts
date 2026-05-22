// Contract 7ae6a26d — CLI is invokable as a /contract --action target.
// Invariant: under --json, stdout MUST be pure JSON. All progress chatter
// (orchestrator [perf], [lifecycle], [direct-document], info() prefixes,
// console.log telemetry) MUST go to stderr so a contract iterate can
// consume stdout as KEY 1 directly.
//
// Pre-fix repro:
//   `bun src/cli.ts resolve --json ...` printed `[perf] direct-document: ...ms`
//   and similar lines on stdout BEFORE the JSON, breaking json.load.
//
// Root-cause fix in src/cli.ts:main(): when flags.json is set, redirect
// console.log/info/warn → process.stderr. output() uses
// process.stdout.write directly, so the JSON payload is preserved.

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");

function runCli(args: string[], timeoutMs = 30_000): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      // Force non-TTY pretty-off path; mirror what a /contract --action gets.
      UNBROWSE_NO_PRETTY: "1",
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

describe("CLI --json: stdout is pure JSON (contract 7ae6a26d)", () => {
  it("resolve --json: stdout parses as a single JSON object", () => {
    const { stdout, status } = runCli([
      "resolve",
      "--json",
      "--intent",
      "github trending repositories",
      "--url",
      "https://github.com/trending",
    ], 90_000);

    // Exit 0 on a clean URL — KEY 1 machine-actionable.
    expect(status).toBe(0);

    // stdout MUST parse as a single JSON object — no prefix lines.
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout);
    expect(parsed).toBeTypeOf("object");
    // resolve always carries a trace.
    expect(parsed.trace).toBeTypeOf("object");
  }, 100_000);

  it("health --json: stdout is pure JSON when the local app is reachable", () => {
    const { stdout, stderr, status } = runCli(["health", "--json"], 15_000);
    // health may return non-zero if no app — but stdout must still parse.
    // (status is informational here; the invariant is on stdout shape.)
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(status).toBeGreaterThanOrEqual(0);
    // No raw "[perf]" / "[lifecycle]" / "[direct-document]" chatter on stdout.
    expect(stdout).not.toContain("[perf]");
    expect(stdout).not.toContain("[lifecycle]");
    expect(stdout).not.toContain("[direct-document]");
    // stderr is allowed to carry whatever (it's NOT KEY 1).
    void stderr;
  }, 20_000);
});
