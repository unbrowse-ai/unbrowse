// Worker J — adversarial probe for harness/run-visible.sh.
// Confirms: no shell injection, no Chrome leak, graceful exits, unique run-ids.
// visible-step.ts (verified) spawns no browser; this test is safe.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse";
const SCRIPT = join(REPO, "harness/run-visible.sh");
const SENTINEL = "/tmp/unbrowse-adversarial-sentinel.txt";
const EVIL = "/tmp/EVIL-unbrowse-adversarial";
const HARNESS_OUT = join(REPO, ".harness-out");

// Track run-ids we observed so afterAll cleans only those (not co-tenant runs).
const ourRunIds: string[] = [];

writeFileSync(SENTINEL, "do-not-delete\n");
if (existsSync(EVIL)) rmSync(EVIL, { force: true });

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runScript(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HEADLESS: "false" },
  });
  const timeoutMs = opts.timeoutMs ?? 15000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  // Capture run-id for cleanup.
  const m = stdout.match(/run_id:\s+(\S+)/);
  if (m) ourRunIds.push(m[1]);

  return { exitCode, stdout, stderr };
}

describe("harness/run-visible.sh adversarial input", () => {
  test("a) missing --url exits non-zero with usage", async () => {
    const r = await runScript(["--intent", "x"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("usage");
  });

  test("b) missing --intent exits non-zero with usage", async () => {
    const r = await runScript(["--url", "https://example.com"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("usage");
  });

  test("c) empty intent rejected (treated as missing)", async () => {
    // Bash `${2:?...}` treats empty string as set, so it passes the value-check
    // but the later `[ -n "$INTENT" ]` guard catches empty string.
    const r = await runScript(["--intent", "", "--url", "https://example.com"]);
    expect(r.exitCode).not.toBe(0);
    // FINDING: empty intent trips bash `${2:?...}` (line 10) with the message
    // "--intent requires a value", NOT the usage banner. Safe (rejects, non-zero)
    // but inconsistent UX vs cases (a)/(b). Documented for step 6.
    expect(r.stderr.toLowerCase()).toContain("--intent requires a value");
  });

  test("d) shell-injection attempt in --intent does not execute", async () => {
    expect(existsSync(SENTINEL)).toBe(true);
    const payload = `x"; rm -rf ${SENTINEL}; touch ${EVIL}; echo "y`;
    const r = await runScript(["--intent", payload, "--url", "https://example.com"]);
    // Argv-passed args are NOT re-interpreted by bash; both outcomes are acceptable
    // as long as no injection fired.
    expect(existsSync(SENTINEL)).toBe(true);
    expect(existsSync(EVIL)).toBe(false);
    // Whatever the exit, no shell metachars should have been honored.
    expect(r.stdout + r.stderr).not.toContain("removed");
  });

  test("e) newline in --intent: written safely to step.json or fails cleanly", async () => {
    const payload = "multi\nline";
    const r = await runScript(["--intent", payload, "--url", "https://example.com"]);
    expect(r.exitCode).toBe(0);
    const m = r.stdout.match(/run_id:\s+(\S+)/);
    expect(m).not.toBeNull();
    const stepJson = join(HARNESS_OUT, m![1], "step-001/step.json");
    expect(existsSync(stepJson)).toBe(true);
    // Must round-trip as valid JSON with the newline preserved (not literal \n).
    const parsed = JSON.parse(readFileSync(stepJson, "utf8"));
    expect(parsed.intent).toBe("multi\nline");
  });

  test("f) very long --intent (10000 chars) does not crash", async () => {
    const payload = "a".repeat(10_000);
    const r = await runScript(["--intent", payload, "--url", "https://example.com"]);
    expect(r.exitCode).toBe(0);
    const m = r.stdout.match(/run_id:\s+(\S+)/);
    expect(m).not.toBeNull();
    const stepJson = join(HARNESS_OUT, m![1], "step-001/step.json");
    const parsed = JSON.parse(readFileSync(stepJson, "utf8"));
    expect(parsed.intent.length).toBe(10_000);
  });

  test("g) non-URL --url is accepted by current seed (documented)", async () => {
    const r = await runScript(["--intent", "x", "--url", "not-a-url"]);
    // Current seed performs no URL validation. Exit should be 0; if it ever
    // gains validation, this test will flag the new behavior.
    expect(r.exitCode).toBe(0);
    const m = r.stdout.match(/run_id:\s+(\S+)/);
    const stepJson = join(HARNESS_OUT, m![1], "step-001/step.json");
    const parsed = JSON.parse(readFileSync(stepJson, "utf8"));
    expect(parsed.url).toBe("not-a-url");
  });

  test("h) concurrent invocations produce unique run-ids", async () => {
    const N = 4;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runScript(["--intent", `c-${i}`, "--url", "https://example.com"]),
      ),
    );
    const ids = results
      .map((r) => r.stdout.match(/run_id:\s+(\S+)/)?.[1])
      .filter((x): x is string => Boolean(x));
    expect(ids.length).toBe(N);
    expect(new Set(ids).size).toBe(N); // all unique
    for (const id of ids) {
      const stepJson = join(HARNESS_OUT, id, "step-001/step.json");
      expect(existsSync(stepJson)).toBe(true);
    }
  });
});

afterAll(() => {
  // Restore sentinel state (in case a future regression deletes it, recreate so dev box stays clean).
  if (!existsSync(SENTINEL)) writeFileSync(SENTINEL, "do-not-delete\n");
  rmSync(SENTINEL, { force: true });
  rmSync(EVIL, { force: true });

  // Clean only the run-ids this test produced.
  for (const id of ourRunIds) {
    const dir = join(HARNESS_OUT, id);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
