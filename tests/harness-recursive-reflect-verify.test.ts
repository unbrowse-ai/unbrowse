import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// Falsifiable contract test for harness/recursive/{reflect.sh,verify.sh}.
//
// Strategy:
//   - Stub `unbrowse` on PATH so that unbrowse-traced runs without needing
//     the real binary. The stub echoes a tiny JSON to stdout and exits 0.
//   - Build calls.jsonl via the REAL unbrowse-traced wrapper so the schema
//     reflect.sh consumes is the schema unbrowse-traced actually writes.
//   - Run the real reflect.sh and verify.sh against that fixture.
//
// This keeps the test grounded in real tools, not fakes of them.

const repoRoot = path.resolve(import.meta.dir, "..");
const harnessDir = path.join(repoRoot, "harness", "recursive");
const tracedBin = path.join(harnessDir, "unbrowse-traced");
const reflectBin = path.join(harnessDir, "reflect.sh");
const verifyBin = path.join(harnessDir, "verify.sh");

let workDir: string;
let stubDir: string;
let runsDir: string;
let createdSessions: string[] = [];

function makeStubUnbrowse(dir: string) {
  mkdirSync(dir, { recursive: true });
  const stubPath = path.join(dir, "unbrowse");
  // Stub: echoes a one-liner JSON-ish marker that reflects argv[0] (the verb).
  // First-line stdout is what reflect.sh will print as `out:`.
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "{\\"stub\\":true,\\"verb\\":\\"$1\\"}"\n` +
      `exit 0\n`,
  );
  chmodSync(stubPath, 0o755);
  return stubPath;
}

function runTraced(session: string, args: string[]) {
  return spawnSync(tracedBin, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      UNBROWSE_TRACE_SESSION: session,
      // Let `command -v unbrowse` resolve to the stub.
      UNBROWSE_BIN: "",
    },
  });
}

beforeAll(() => {
  // Sanity: the harness scripts under test must exist.
  expect(existsSync(tracedBin)).toBe(true);
  expect(existsSync(reflectBin)).toBe(true);
  expect(existsSync(verifyBin)).toBe(true);

  workDir = mkdtempSync(path.join(os.tmpdir(), "harness-reflect-verify-"));
  stubDir = path.join(workDir, "stub-bin");
  makeStubUnbrowse(stubDir);
  runsDir = path.join(harnessDir, "runs");
  mkdirSync(runsDir, { recursive: true });
});

afterAll(() => {
  // Clean up only sessions we created — never touch others.
  for (const sess of createdSessions) {
    const dir = path.join(runsDir, sess);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const after = path.join(runsDir, `${sess}.after`);
    if (existsSync(after)) rmSync(after, { recursive: true, force: true });
  }
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("harness/recursive reflect.sh", () => {
  it("exits 1 with helpful message when calls.jsonl is missing", () => {
    const session = `test-missing-${Date.now()}`;
    createdSessions.push(session);
    // Note: do NOT create the dir — reflect.sh must handle absence.
    const res = spawnSync("bash", [reflectBin, session], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no calls");
  });

  it("prints all rows in append order with a row block per call", () => {
    const session = `test-order-${Date.now()}`;
    createdSessions.push(session);

    // Build 3 calls via the real wrapper, each verb distinct so we can spot
    // ordering failures (the script must print 1,2,3 — not sorted/reversed).
    const verbs = ["resolve", "execute", "feedback"];
    for (const v of verbs) {
      const r = runTraced(session, [v, "--flag", `arg-${v}`]);
      expect(r.status).toBe(0);
    }

    const log = path.join(runsDir, session, "calls.jsonl");
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);

    const res = spawnSync("bash", [reflectBin, session], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const stdout = res.stdout;
    // Each call gets a "#NN" header, in order.
    const idxResolve = stdout.indexOf("resolve");
    const idxExecute = stdout.indexOf("execute");
    const idxFeedback = stdout.indexOf("feedback");
    expect(idxResolve).toBeGreaterThan(-1);
    expect(idxExecute).toBeGreaterThan(idxResolve);
    expect(idxFeedback).toBeGreaterThan(idxExecute);
    // Header count matches row count.
    const rowHeaders = stdout.match(/#0\d \[/g) ?? [];
    expect(rowHeaders.length).toBe(3);
    // Session line.
    expect(stdout).toContain(`session ${session}`);
    expect(stdout).toContain("3 calls");
  });
});

describe("harness/recursive verify.sh", () => {
  it("replays a 2-row fails file and produces 2 calls in <prior>.after/calls.jsonl", () => {
    const prior = `test-verify-${Date.now()}`;
    createdSessions.push(prior);
    // Seed the prior session with one call so the prior dir exists.
    const seed = runTraced(prior, ["resolve", "--intent", "seed"]);
    expect(seed.status).toBe(0);

    // Fails file with two argv entries.
    const failsPath = path.join(workDir, `${prior}.fails.jsonl`);
    writeFileSync(
      failsPath,
      [
        JSON.stringify({ argv: ["resolve", "--intent", "a"] }),
        JSON.stringify({ argv: ["execute", "--skill", "b"] }),
      ].join("\n") + "\n",
    );

    const res = spawnSync("bash", [verifyBin, prior, failsPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });
    expect(res.status).toBe(0);

    const afterLog = path.join(runsDir, `${prior}.after`, "calls.jsonl");
    expect(existsSync(afterLog)).toBe(true);
    const rows = readFileSync(afterLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(rows.length).toBe(2);
    const parsed = rows.map((r) => JSON.parse(r));
    expect(parsed[0].verb).toBe("resolve");
    expect(parsed[1].verb).toBe("execute");
  });

  it("skips malformed JSON lines without crashing (lost-sheep)", () => {
    const prior = `test-verify-malformed-${Date.now()}`;
    createdSessions.push(prior);
    const seed = runTraced(prior, ["resolve", "--intent", "seed"]);
    expect(seed.status).toBe(0);

    const failsPath = path.join(workDir, `${prior}.bad.jsonl`);
    // 1 good, 1 malformed, 1 good — middle line must be skipped.
    writeFileSync(
      failsPath,
      [
        JSON.stringify({ argv: ["resolve", "--intent", "ok1"] }),
        "{this is not valid json",
        JSON.stringify({ argv: ["feedback", "--note", "ok2"] }),
      ].join("\n") + "\n",
    );

    const res = spawnSync("bash", [verifyBin, prior, failsPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });
    // Verify.sh is allowed to surface a non-zero exit if the python loop
    // raises — the falsifiable claim is that BOTH valid lines still replay.
    // We assert behavior, not exit code, because skip-and-continue is the
    // contract. If the implementation crashes mid-file, the second valid
    // row never runs and this assertion fails.
    const afterLog = path.join(runsDir, `${prior}.after`, "calls.jsonl");
    const rows = existsSync(afterLog)
      ? readFileSync(afterLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const verbs = rows.map((r) => JSON.parse(r).verb);
    expect(verbs).toContain("resolve");
    expect(verbs).toContain("feedback");
    // And only the two valid lines — never 3.
    expect(rows.length).toBe(2);
    // Surface the script's stderr for debug if we ever regress.
    if (rows.length !== 2) {
      console.error("verify.sh stderr:", res.stderr);
      console.error("verify.sh stdout:", res.stdout);
    }
  });
});
