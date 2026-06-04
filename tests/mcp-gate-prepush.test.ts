// Real-runtime test for scripts/mcp-gate-prepush.sh (the .husky/pre-push
// MCP-surface gate). No mocks: spawns the real script against the real
// git repo with crafted pre-push stdin (`<local ref> <local sha>
// <remote ref> <remote sha>`) and asserts exit codes. Mirrors how git
// invokes the hook. .bench-gate is gitignored, so the stamp fixture is
// created/removed in-place and never leaks into git.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const REPO = process.cwd();
const SCRIPT = "scripts/mcp-gate-prepush.sh";
const STAMP = ".bench-gate/stamp.mcp.json";
const STAMP_BAK = ".bench-gate/stamp.mcp.json.testbak";

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
  mkdirSync(".bench-gate", { recursive: true });
  if (existsSync(STAMP)) renameSync(STAMP, STAMP_BAK);
});
afterEach(() => {
  if (existsSync(STAMP)) rmSync(STAMP);
  if (existsSync(STAMP_BAK)) renameSync(STAMP_BAK, STAMP);
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

  it("BLOCKS a push to main that changes gate-affecting code with no MCP stamp", () => {
    if (!ORIGIN_MAIN) return; // requires origin/main; skip if absent
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`);
    expect(code).toBe(1);
    expect(out).toContain("no MCP-surface stamp");
    expect(out).toContain("/unbrowse-mcp-gate");
  });

  it("allows the same push when a fresh matching MCP stamp exists", () => {
    if (!ORIGIN_MAIN) return;
    writeFileSync(
      STAMP,
      JSON.stringify({
        schema_version: 1,
        commit_sha: HEAD,
        run_id: "test-run",
        gate_passed: true,
        surface: "mcp",
        index_coverage: 0.9,
        retrieve_coverage: 0.8,
      }) + "\n",
    );
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`);
    expect(code).toBe(0);
    expect(out).toContain("MCP stamp matches pushed HEAD");
  });

  it("BLOCKS when the stamp exists but gate_passed is not true", () => {
    if (!ORIGIN_MAIN) return;
    writeFileSync(STAMP, JSON.stringify({ commit_sha: HEAD, gate_passed: false }) + "\n");
    const { code, out } = runHook(`refs/heads/main ${HEAD} refs/heads/main ${ORIGIN_MAIN}`);
    expect(code).toBe(1);
    expect(out).toContain("gate_passed=false");
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
