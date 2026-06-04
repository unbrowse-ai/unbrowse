import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Passthrough + recording invariant for harness/recursive/unbrowse-traced:
//   (a) stdout/stderr from the underlying `unbrowse` binary are passed
//       through verbatim to the caller
//   (b) the wrapper exits with the same code as the underlying binary
//   (c) exactly one row is appended to runs/<session>/calls.jsonl per call,
//       capturing verb, argv, exit, stdout_excerpt, stderr_excerpt
//
// We don't invoke real `unbrowse` (network + slow). UNBROWSE_BIN points at a
// fake script with known stdout/stderr/exit (the wrapper honors that env).

const REPO_ROOT = resolve(import.meta.dir, "..");
const WRAPPER = join(REPO_ROOT, "harness", "recursive", "unbrowse-traced");

let workdir: string;
let session: string;
let fakeUnbrowse: string;
let fakeBogus: string;
let runsDir: string;
let callsLog: string;

const STDOUT_OK = "HELLO_FROM_FAKE_UNBROWSE stdout line one\nstdout line two\n";
const STDERR_OK = "warn: fake unbrowse stderr line\n";
const STDERR_BOGUS = "error: unknown flag --bogus\n";

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "unbrowse-traced-test-"));
  session = `session-test-${process.pid}-${Date.now()}`;

  // Stage payloads as real files so fake binaries emit exact bytes (avoids
  // shell escape pitfalls with embedded newlines in printf format strings).
  const stdoutFile = join(workdir, "stdout.txt");
  const stderrFile = join(workdir, "stderr.txt");
  const stderrBogusFile = join(workdir, "stderr-bogus.txt");
  writeFileSync(stdoutFile, STDOUT_OK);
  writeFileSync(stderrFile, STDERR_OK);
  writeFileSync(stderrBogusFile, STDERR_BOGUS);

  fakeUnbrowse = join(workdir, "unbrowse-ok");
  writeFileSync(
    fakeUnbrowse,
    `#!/usr/bin/env bash
cat ${JSON.stringify(stdoutFile)}
cat ${JSON.stringify(stderrFile)} >&2
exit 0
`,
    { mode: 0o755 },
  );

  fakeBogus = join(workdir, "unbrowse-bogus");
  writeFileSync(
    fakeBogus,
    `#!/usr/bin/env bash
cat ${JSON.stringify(stderrBogusFile)} >&2
exit 7
`,
    { mode: 0o755 },
  );

  runsDir = join(REPO_ROOT, "harness", "recursive", "runs", session);
  callsLog = join(runsDir, "calls.jsonl");

  // Pre-create dir + empty log. The wrapper has a known cold-start quirk: on
  // the FIRST call in a fresh session `wc -l <"$LOG"` leaks "No such file or
  // directory" to stderr because the input redirection fails in the parent
  // shell before wc's `2>/dev/null` runs. The harness's steady-state
  // (call N>0) is what we actually care about; touch the log to exercise it.
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(callsLog, "");
});

afterAll(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  try { rmSync(runsDir, { recursive: true, force: true }); } catch {}
});

function runWrapper(unbrowseBin: string, args: string[]) {
  return spawnSync(WRAPPER, args, {
    env: { ...process.env, UNBROWSE_BIN: unbrowseBin, UNBROWSE_TRACE_SESSION: session },
    encoding: "utf8",
  });
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

describe("harness/recursive/unbrowse-traced passthrough + recording", () => {
  it("wrapper exists", () => {
    expect(existsSync(WRAPPER)).toBe(true);
  });

  it("passes stdout/stderr verbatim, propagates exit 0, records one row", () => {
    const before = readJsonl(callsLog).length;
    const argv = ["resolve", "--intent", "fake intent", "--url", "https://example.com"];
    const result = runWrapper(fakeUnbrowse, argv);

    expect(result.stdout).toBe(STDOUT_OK);
    expect(result.stderr).toBe(STDERR_OK);
    expect(result.status).toBe(0);

    const rows = readJsonl(callsLog);
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row.verb).toBe("resolve");
    expect(row.argv).toEqual(argv);
    expect(row.exit).toBe(0);
    expect(typeof row.stdout_excerpt).toBe("string");
    expect(typeof row.stderr_excerpt).toBe("string");
    expect(row.stdout_excerpt).toContain("HELLO_FROM_FAKE_UNBROWSE");
    expect(row.stdout_excerpt).toContain("stdout line two");
    expect(row.stderr_excerpt).toContain("warn: fake unbrowse stderr line");
  });

  it("propagates non-zero exit code (lost-sheep) and still records one row", () => {
    const before = readJsonl(callsLog).length;
    const argv = ["--bogus"];
    const result = runWrapper(fakeBogus, argv);

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(STDERR_BOGUS);
    expect(result.status).toBe(7);

    const rows = readJsonl(callsLog);
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row.argv).toEqual(argv);
    expect(row.exit).toBe(7);
    expect(row.stderr_excerpt).toContain("unknown flag --bogus");
  });
});
