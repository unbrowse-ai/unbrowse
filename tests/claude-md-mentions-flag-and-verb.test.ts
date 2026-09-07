// Runtime authority doc sentinel — CLAUDE.md must preserve the stateless
// binary invariant while still documenting explicit compatibility knobs.
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("CLAUDE.md runtime authority sentinel", () => {
  test("mentions stateless runtime and explicit compatibility knobs", async () => {
    const content = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf8");

    expect(content).toContain("stateless `unbrowse` binary");
    expect(content).toContain("must not auto-spawn a local Fastify daemon");
    expect(content).toContain("--no-auto-start");
    expect(content).toContain("unbrowse serve");
    expect(content).toContain("MCP_SERVER_MODE");
    expect(content).toContain("UNBROWSE_SERVE_IDLE_MS");
  });

  test("does not preserve stale daemon-cleanup guidance as the architecture", async () => {
    const content = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf8");

    expect(content).not.toMatch(/older CLI\/MCP flows can still auto-spawn/);
    expect(content).not.toMatch(/pkill remains/);
  });
});
