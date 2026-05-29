// Mutation test for scripts/client-audit-gate.sh (gate 5).
// Luke 15:4 — the one failing case teaches more than ninety-nine passing.
// A gate that cannot fail is fake-green; this proves it fails-closed:
//   - PASS on the real client surface (exit 0),
//   - FAIL on an unaudited public export (completeness),
//   - FAIL on an injected moat term in client source (no-leak).
// The gate reads CLIENT_AUDIT_{INDEX,TSV,SRC} env overrides so we can point it
// at fixtures without touching the real surface.
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const GATE = "scripts/client-audit-gate.sh";

function runGate(env: Record<string, string> = {}) {
  return spawnSync("bash", [GATE], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("client-audit-gate", () => {
  it("PASSES on the real @unbrowse/client surface (exit 0)", () => {
    const r = runGate();
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(r.status).toBe(0);
    expect(out).toContain("CLIENT-AUDIT-GATE PASS");
    expect(out).toMatch(/reflect: \d+ public export\(s\), 0 unaudited/);
  });

  it("FAILS when a public export has no audit row (completeness fails-closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cag-unaudited-"));
    try {
      writeFileSync(join(dir, "index.ts"), 'export { FakeUnauditedThing } from "./x.js";\n');
      // audit map deliberately omits FakeUnauditedThing
      writeFileSync(join(dir, "audit.tsv"), "# header\nUnbrowse\tclass\tanchor\treason\n");
      const srcDir = join(dir, "src");
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, "clean.ts"), "export const ok = 1;\n");
      const r = runGate({
        CLIENT_AUDIT_INDEX: join(dir, "index.ts"),
        CLIENT_AUDIT_TSV: join(dir, "audit.tsv"),
        CLIENT_AUDIT_SRC: srcDir,
      });
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      expect(r.status).toBe(1);
      expect(out).toContain("UNAUDITED public export");
      expect(out).toContain("FakeUnauditedThing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS when a moat term leaks into client source (no-leak fails-closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cag-leak-"));
    try {
      // no exports -> completeness trivially passes; the leak check must catch it
      writeFileSync(join(dir, "index.ts"), "// no exports here\n");
      writeFileSync(join(dir, "audit.tsv"), "# header\n");
      const srcDir = join(dir, "src");
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, "leaky.ts"), "// uses captureEngine internals\nconst x = 1;\n");
      const r = runGate({
        CLIENT_AUDIT_INDEX: join(dir, "index.ts"),
        CLIENT_AUDIT_TSV: join(dir, "audit.tsv"),
        CLIENT_AUDIT_SRC: srcDir,
      });
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      expect(r.status).toBe(1);
      expect(out).toContain("MOAT TERM in client source");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
