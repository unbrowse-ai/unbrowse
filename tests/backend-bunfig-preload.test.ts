// Backend bunfig preload coverage — Phase 1.1 Day-5 creature.
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default";

describe("backend bunfig preload", () => {
  test("running bun test from backend/ cwd preloads tests/_setup.ts (sets UNBROWSE_INLINE_INDEX)", async () => {
    const sentinelPath = join(REPO_ROOT, "backend", "tests", "__bunfig-preload-sentinel.test.ts");
    await mkdir(join(REPO_ROOT, "backend", "tests"), { recursive: true });
    const sentinel = `
import { test, expect } from "bun:test";
test("preload fired", () => {
  expect(process.env.UNBROWSE_INLINE_INDEX).toBe("1");
  expect(process.env.UNBROWSE_NO_SWEEP).toBe("1");
});
`;
    await writeFile(sentinelPath, sentinel);
    try {
      const childEnv = { ...process.env };
      delete childEnv.UNBROWSE_INLINE_INDEX;
      delete childEnv.UNBROWSE_NO_SWEEP;
      const result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolveP) => {
        const child = spawn("bun", ["test", "./tests/__bunfig-preload-sentinel.test.ts"], {
          cwd: join(REPO_ROOT, "backend"),
          env: childEnv,
          stdio: "pipe",
        });
        let stderr = "";
        let stdout = "";
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolveP({ code: code ?? -1, stderr, stdout });
        });
      });
      expect(result.code).toBe(0);
    } finally {
      await rm(sentinelPath, { force: true });
    }
  }, 20_000);
});
