// Phase 2 Day-5 doc sentinel — CLAUDE.md must mention the auto-spawn
// daemon mitigations. If any key string drifts out, this test fails;
// the contributor must re-add it or justify the removal in PR review.
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default";

describe("CLAUDE.md Phase-2 doc sentinel", () => {
  test("mentions --no-auto-start, unbrowse serve, MCP_SERVER_MODE, UNBROWSE_SERVE_IDLE_MS", async () => {
    const content = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf8");

    // Each of these strings must appear at least once.
    expect(content).toContain("--no-auto-start");
    expect(content).toContain("unbrowse serve");
    expect(content).toContain("MCP_SERVER_MODE");
    expect(content).toContain("UNBROWSE_SERVE_IDLE_MS");
  });

  test("includes the structural footgun context (auto-spawned daemon, MCP, pkill remains the fallback)", async () => {
    const content = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf8");

    // Structural — not exact wording. The phrase "auto-spawn" OR "auto-spawned"
    // or "spawns" near "daemon" / "Fastify" should appear, plus pkill still
    // mentioned as the nuclear option.
    expect(/auto[-]?spawn/.test(content)).toBe(true);
    expect(content).toContain("pkill");
  });
});
