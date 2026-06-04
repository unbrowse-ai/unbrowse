// Mutation test for scripts/leak-guard.sh (the moat no-leak gate).
//  — the one failing case teaches more than ninety-nine passing.
// A gate that cannot fail is fake-green; this proves leak-guard fails-closed:
//   - PASS on a temp dir whose public README is clean (exit 0),
//   - FAIL when a real sensitive/moat name is injected into a public path.
// The gate reads the LEAK_GUARD_ROOT env override so we can point its scan
// root at a fixture temp dir without ever touching the live tree.
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const GATE = "scripts/leak-guard.sh";

function runGate(root: string) {
  return spawnSync("bash", [GATE], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LEAK_GUARD_ROOT: root,
      // Isolate from any real skill-repo mirror on this machine.
      UNBROWSE_SKILL_REPO: join(root, "__no_such_skill_repo__"),
    },
  });
}

// Build a minimal fake scan root mirroring leak-guard's PUBLIC_PATHS shape.
// `readmeContent` is the only variable: clean vs poisoned.
function makeFixtureRoot(readmeContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), "leak-guard-"));
  writeFileSync(join(dir, "README.md"), readmeContent);
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "index.md"), "# clean docs\n");
  return dir;
}

describe("leak-guard-gate", () => {
  it("PASSES on a clean public surface (exit 0)", () => {
    const dir = makeFixtureRoot("# Unbrowse\n\nClean public readme, no moat terms.\n");
    try {
      const r = runGate(dir);
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      expect(r.status).toBe(0);
      expect(out).toContain("no sensitive names in public paths");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS when a sensitive primitive name leaks into a public path (no-leak fails-closed)", () => {
    // "coverage-harness" is in SENSITIVE_NAMES — always enforced, not strict-only.
    const dir = makeFixtureRoot(
      "# Unbrowse\n\nThis README accidentally documents the coverage-harness primitive.\n",
    );
    try {
      const r = runGate(dir);
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      expect(r.status).not.toBe(0);
      expect(out).toContain("LEAK in public path");
      expect(out).toContain("coverage-harness");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
