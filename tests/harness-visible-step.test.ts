import { describe, expect, it, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Locks the visible-step artifact contract in place. Schema drift in
// harness/visible-step.ts or run-id format drift in harness/run-visible.sh
// breaks this test. Real spawn, real fs, real shell — no mocks.

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[a-f0-9]{8}$/;

const createdRunDirs: string[] = [];

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

async function runHarness(intent: string, url: string) {
  const proc = Bun.spawn({
    cmd: ["bash", "harness/run-visible.sh", "--intent", intent, "--url", url],
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("harness/run-visible.sh — visible step artifact contract", () => {
  afterAll(() => {
    for (const dir of createdRunDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("emits a step.json that matches the declared schema and run-id format", async () => {
    const { stdout, stderr, exitCode } = await runHarness(
      "test-schema",
      "https://example.com",
    );
    expect(exitCode).toBe(0);

    const combined = stdout + "\n" + stderr;
    const artifactDirMatch = combined.match(/artifact_dir:\s*(\S+)/);
    expect(artifactDirMatch).not.toBeNull();
    const artifactDir = artifactDirMatch![1];
    createdRunDirs.push(artifactDir);

    // run-id is the basename of the artifact dir.
    const runId = artifactDir.split("/").pop()!;
    expect(runId).toMatch(RUN_ID_RE);

    const stepJsonPath = join(artifactDir, "step-001", "step.json");
    expect(existsSync(stepJsonPath)).toBe(true);

    const raw = readFileSync(stepJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Required string fields.
    for (const k of [
      "step_id",
      "intent",
      "url",
      "screenshot_path",
      "a11y_path",
      "har_path",
      "resolve_path",
      "kuri_log_path",
      "started_at",
      "ended_at",
      "status",
    ]) {
      expect(isString(parsed[k])).toBe(true);
    }
    expect(isBool(parsed.visible)).toBe(true);
    // kuri_pid is number | null
    expect(parsed.kuri_pid === null || typeof parsed.kuri_pid === "number").toBe(true);

    // Pinned values.
    expect(parsed.step_id).toBe("step-001");
    expect(parsed.status).toBe("declared");
    expect(parsed.intent).toBe("test-schema");
    expect(parsed.url).toBe("https://example.com");
    // HEADLESS=false is set by the wrapper.
    expect(parsed.visible).toBe(true);

    // ISO 8601 timestamps.
    const startedAt = parsed.started_at as string;
    const endedAt = parsed.ended_at as string;
    expect(Number.isFinite(Date.parse(startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(endedAt))).toBe(true);
    // ISO 8601 with Z (UTC)
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
});
