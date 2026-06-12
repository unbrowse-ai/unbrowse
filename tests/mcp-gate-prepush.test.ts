// Real-runtime test for scripts/mcp-gate-prepush.sh (the .husky/pre-push
// MCP-surface gate). No mocks: spawns the real script against the real
// git repo with crafted pre-push stdin (`<local ref> <local sha>
// <remote ref> <remote sha>`) and asserts exit codes. Mirrors how git
// invokes the hook. The real meta-harness ledger is backed up and restored
// around each fixture.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

const REPO = process.cwd();
const SCRIPT = "scripts/mcp-gate-prepush.sh";
const LEDGER_DIR = "(internal)";
const LEDGER = `${LEDGER_DIR}/iterations.jsonl`;
const LEDGER_BAK = `${LEDGER_DIR}/iterations.jsonl.testbak`;

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
// origin/main lacks this branch's src fixes -> a real gate-affecting delta.
let ORIGIN_MAIN = "";
try {
  ORIGIN_MAIN = execFileSync("git", ["rev-parse", "origin/main"], { cwd: REPO, encoding: "utf8" }).trim();
} catch { ORIGIN_MAIN = ""; }

function runHook(refLine: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, "origin", "https://example.test/repo.git"], {
    cwd: REPO,
    input: refLine + "\n",
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

beforeEach(() => {
  mkdirSync(LEDGER_DIR, { recursive: true });
  if (existsSync(LEDGER_BAK)) rmSync(LEDGER_BAK);
  if (existsSync(LEDGER)) renameSync(LEDGER, LEDGER_BAK);
});
afterEach(() => {
  if (existsSync(LEDGER)) rmSync(LEDGER);
  if (existsSync(LEDGER_BAK)) renameSync(LEDGER_BAK, LEDGER);
});

describe("mcp-gate-prepush.sh", () => {
  it("allows a non-main push regardless of stamp", () => {
    const { code } = runHook(`refs/heads/feature ${HEAD} refs/heads/feature ${HEAD}`);
    expect(code).toBe(0);
  });

  it("allows a push to main with no gate-affecting delta (pushed == remote)", () => {
    // base = remote_sha = HEAD, pushed = HEAD -> git diff is empty.
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${HEAD}`);
    expect(code).toBe(0);
    expect(out).toContain("no gate-affecting paths changed");
  });

  it("BLOCKS a push to main that changes gate-affecting code with no harness ledger", () => {
    if (!ORIGIN_MAIN) return; // requires origin/main; skip if absent
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`);
    expect(code).toBe(1);
    expect(out).toContain("no harness ledger");
    expect(out).toContain("harness iterate");
  });

  it("allows the same push when a fresh passing harness ledger row exists", () => {
    if (!ORIGIN_MAIN) return;
    writeFileSync(
      LEDGER,
      JSON.stringify({
        iter: 999,
        ts: new Date().toISOString(),
        status: "verified",
        exit_code: 0,
        note: "test harness row",
      }) + "\n",
    );
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`);
    expect(code).toBe(0);
    expect(out).toContain("harness ledger row post-dates capability code");
  });

  it("BLOCKS when the ledger exists but latest status is not passing", () => {
    if (!ORIGIN_MAIN) return;
    writeFileSync(LEDGER, JSON.stringify({
      iter: 999,
      ts: new Date().toISOString(),
      status: "failed",
      exit_code: 1,
    }) + "\n");
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`);
    expect(code).toBe(1);
    expect(out).toContain("latest harness row status is 'failed'");
  });

  it("MCP_GATE_BYPASS=1 allows the push but logs loudly", () => {
    if (!ORIGIN_MAIN) return;
    const { code, out } = runHook(
      `refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`,
      { MCP_GATE_BYPASS: "1" },
    );
    expect(code).toBe(0);
    expect(out).toContain("BYPASSED");
  });
});
