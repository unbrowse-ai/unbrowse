/**
 * Worker F — Step 5 golden integration test.
 *
 * Falsifiable assertion: when `bun src/cli.ts go <url>` runs with default env,
 * Kuri spawns Chrome with `--headless=new` and no visible window flashes.
 *
 * The CLI's surfaced stdout does NOT contain Kuri's banner ("starting in
 * headless mode") because Kuri's stderr is captured internally. The
 * load-bearing check is OS-level: while Kuri is alive, read every Chrome
 * process's argv via `ps` and confirm `--headless=new` is present.
 *
 * Skipped on CI by default — spawns a real browser.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");
const SKIP = process.env.CI === "true";

function killAll() {
  spawnSync("pkill", ["-9", "-f", "kuri|chrome"], { stdio: "ignore" });
}

describe.skipIf(SKIP)("integration: headless golden (Worker F)", () => {
  beforeAll(() => {
    killAll();
    spawnSync("sleep", ["3"]);
  });

  afterAll(() => {
    killAll();
  });

  it("spawns Chrome with --headless=new and exits cleanly", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", CLI, "go", "https://example.com"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    const combined = `${stdout}\n${stderr}`;

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain('"ok":true');
    expect(stdout).toMatch(/"session_id":"[0-9a-f-]+"/);
    expect(combined).not.toContain("no existing Chrome found");

    // Load-bearing: read live Chrome argv via ps; confirm --headless=new.
    const pgrep = spawnSync("pgrep", ["-f", "Google Chrome"], { encoding: "utf8" });
    const pids = (pgrep.stdout || "").trim().split("\n").filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    const ps = spawnSync("ps", ["-o", "command=", "-p", pids.join(",")], { encoding: "utf8" });
    expect(ps.stdout || "").toMatch(/--headless=new/);
  }, 60_000);
});
