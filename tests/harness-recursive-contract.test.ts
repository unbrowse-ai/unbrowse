// harness-recursive-contract.test.ts
//
// Falsifiable architectural-contract tests for harness/recursive/.
// The harness has a strict contract (see harness/recursive/README.md):
//   - the agent is the probe, the harness only watches
//   - no script auto-runs unbrowse against corpus, no script auto-applies
//     patches, no script grep-classifies a live session into PASS/FAIL,
//     and the transparent wrapper must not alter stdout/stderr.
//
// Each test below reads the relevant harness file(s) and asserts the
// anti-pattern is absent. These are guards, not behavior tests — they
// run in milliseconds and fail loudly if anyone reintroduces a banned
// pattern.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HARNESS_DIR = join(import.meta.dir, "..", "harness", "recursive");

function listShellScripts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isFile() && name.endsWith(".sh")) out.push(p);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("harness/recursive contract", () => {
  test("(1) no .sh script grep-classifies a live calls.jsonl into PASS/FAIL", () => {
    // Anti-pattern: a script that reads a session's calls.jsonl and emits
    // PASS/FAIL — that's the agent's job per judge.md. Shell comments are
    // stripped before the verdict check so prose like "# PASS iff ..." in
    // verify.sh's tail message doesn't trip the guard.
    const offenders: { file: string; reason: string }[] = [];
    for (const file of listShellScripts(HARNESS_DIR)) {
      const body = read(file);
      const readsCalls =
        /cat\s+[^\n]*calls\.jsonl/.test(body) ||
        /<\s*[^\n]*calls\.jsonl/.test(body) ||
        /open\([^)]*calls\.jsonl/.test(body);
      const nonCommentBody = body
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
      const emitsVerdict = /\b(PASS|FAIL)\b/.test(nonCommentBody);
      if (readsCalls && emitsVerdict) {
        offenders.push({
          file,
          reason: "reads calls.jsonl AND emits PASS/FAIL on a non-comment line",
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("(2) no .sh script loops over corpus.txt and execs `unbrowse ` directly", () => {
    // Anti-pattern: a synthetic corpus runner that bypasses the agent.
    // mine-sessions.sh and verify.sh are explicit exceptions per README.md
    // (mine-sessions reads ~/.claude jsonl, verify.sh replays a fail-list
    //  via unbrowse-traced).
    const ALLOWED = new Set(["mine-sessions.sh", "verify.sh"]);
    const offenders: { file: string; reason: string }[] = [];
    for (const file of listShellScripts(HARNESS_DIR)) {
      const base = file.split("/").pop()!;
      if (ALLOWED.has(base)) continue;
      const body = read(file);
      const loopsCorpus =
        /corpus\.txt/.test(body) &&
        /(while\s+(read|IFS)|for\s+\w+\s+in\b|<\s*\$?\{?[A-Z_]*corpus|cat\s+[^\n]*corpus\.txt)/i.test(
          body,
        );
      // A direct `unbrowse ` invocation that is NOT routed through unbrowse-traced.
      const directInvoke = body.split("\n").some((line) => {
        if (/^\s*#/.test(line)) return false;
        if (/unbrowse-traced/.test(line)) return false;
        return /(^|[\s;&|`(])(?:\.\/|\$\(?[A-Z_]*UNBROWSE[A-Z_]*\)?\s|unbrowse)\s+(resolve|execute|go|snap|close)\b/.test(
          line,
        );
      });
      if (loopsCorpus && directInvoke) {
        offenders.push({
          file,
          reason: "loops corpus.txt AND execs unbrowse directly",
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("(3) no script auto-applies patches to src/", () => {
    // Anti-pattern: harness mutating product code without the agent in the
    // loop (README.md §4 — `Apply the patch.` is agent-driven).
    const offenders: { file: string; reason: string }[] = [];
    for (const name of readdirSync(HARNESS_DIR)) {
      const file = join(HARNESS_DIR, name);
      const st = statSync(file);
      if (!st.isFile()) continue;
      // Skip docs/data — they may legitimately discuss the rule.
      if (name.endsWith(".md") || name === "corpus.txt") continue;
      const body = read(file);
      const stripped = body
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
      const patterns: { re: RegExp; label: string }[] = [
        { re: /\bgit\s+apply\b/, label: "git apply" },
        { re: /\bgit\s+am\b/, label: "git am" },
        { re: /\bpatch\s+-p\d/, label: "patch -pN" },
        {
          re: /(>{1,2}|tee)\s+[^\n]*\.\.\/\.\.\/src\//,
          label: "redirect into ../../src/",
        },
        {
          re: /\bmuonry\s+(edit|patch|create)\b[^\n]*src\//,
          label: "muonry edit/patch/create against src/",
        },
        { re: /\bsed\s+-i[^\n]*\.\.\/\.\.\/src\//, label: "sed -i against ../../src/" },
      ];
      for (const { re, label } of patterns) {
        if (re.test(stripped)) {
          offenders.push({ file: name, reason: label });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("(4) verify.sh does not shell-interpolate JSON into python", () => {
    // Regression guard: previously verify.sh assembled a python invocation
    // by interpolating $argv_json (or similar) into the python source. That
    // is RCE-by-newline. The fix passes paths positionally and lets python
    // open() them. We assert the bad shape stays gone.
    const file = join(HARNESS_DIR, "verify.sh");
    const body = read(file);

    const banned = [
      /subprocess\.(?:call|run|Popen)\s*\([^)]*\$\{?[A-Za-z_][A-Za-z0-9_]*_json\}?/,
      /python3?\s+-c\s+[^\n]*\$\{?[A-Za-z_][A-Za-z0-9_]*_json\}?/,
      /python3?\s+<<[^\n]*\n[^]*?\$\{?[A-Za-z_][A-Za-z0-9_]*_json\}?[^]*?\nPY/,
      /json\.loads\s*\([^)]*\$\{?[A-Za-z_]/,
    ];
    for (const re of banned) {
      expect(body).not.toMatch(re);
    }

    // Positive shape: the python heredoc must be single-quoted (<<'PY')
    // so $vars inside it do NOT expand at the shell level.
    expect(body).toMatch(/<<'PY'/);
  });

  test("(5) unbrowse-traced passes stdout/stderr through verbatim", () => {
    // Proof-by-line that the wrapper does not prefix, filter, or swallow
    // either stream. If someone refactors these into `sed s/^/[ub]/` or
    // similar, this test fails and forces a discussion.
    const file = join(HARNESS_DIR, "unbrowse-traced");
    const body = read(file);

    expect(body).toMatch(/^\s*cat\s+"\$stdout_file"\s*$/m);
    expect(body).toMatch(/^\s*cat\s+"\$stderr_file"\s*>&2\s*$/m);

    const altering = [
      /sed[^\n]*"?\$stdout_file/,
      /sed[^\n]*"?\$stderr_file/,
      /awk[^\n]*"?\$stdout_file/,
      /awk[^\n]*"?\$stderr_file/,
      /grep[^\n]*"?\$stdout_file/,
      /grep[^\n]*"?\$stderr_file/,
    ];
    for (const re of altering) {
      expect(body).not.toMatch(re);
    }

    // Final exit must propagate the real rc.
    expect(body).toMatch(/exit\s+"\$rc"/);
  });
});

// (6) The agent-takes-no-wheel guard: synthetic probe runners that drive
// `unbrowse` against the corpus on their own are explicitly banned. Lewis
// killed `probe.sh` once; this test fails loudly if it ever returns.
describe("(6) banned synthetic-runner files cannot exist in harness/recursive/", () => {
  test("no probe.sh / loop.sh / driver.sh / runner.sh in harness/recursive/", () => {
    const banned = new Set(["probe.sh", "loop.sh", "driver.sh", "runner.sh", "auto.sh"]);
    const present = readdirSync(HARNESS_DIR).filter((n) => banned.has(n));
    expect(present).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Lost-sheep canary — kept as describe.skip so it does NOT run, but stays
// in the file so future devs see exactly the kind of regression these
// guards are meant to catch. Un-skip locally to confirm the guards bite.
// ─────────────────────────────────────────────────────────────────────────
describe.skip("CANARY: what an introduced anti-pattern would look like", () => {
  test("synthetic verify.sh that grep-classifies calls.jsonl", () => {
    const fakeScript = [
      "#!/usr/bin/env bash",
      'cat runs/$1/calls.jsonl | while read line; do',
      '  if echo "$line" | grep -q error; then echo FAIL; else echo PASS; fi',
      "done",
    ].join("\n");
    // This shape would (correctly) be caught by test (1):
    expect(/cat\s+[^\n]*calls\.jsonl/.test(fakeScript)).toBe(true);
    expect(/\b(PASS|FAIL)\b/.test(fakeScript)).toBe(true);
  });

  test("synthetic probe.sh that loops corpus and runs unbrowse directly", () => {
    const fakeScript = [
      "#!/usr/bin/env bash",
      "while IFS='|' read intent url _; do",
      '  unbrowse resolve --intent "$intent" --url "$url"',
      "done < harness/recursive/corpus.txt",
    ].join("\n");
    // Caught by test (2).
    expect(/corpus\.txt/.test(fakeScript)).toBe(true);
    expect(/unbrowse\s+resolve/.test(fakeScript)).toBe(true);
  });

  test("synthetic auto-patcher writing into src/", () => {
    const fakeScript = [
      "#!/usr/bin/env bash",
      "git apply harness/recursive/runs/latest.patch",
    ].join("\n");
    // Caught by test (3).
    expect(/git\s+apply/.test(fakeScript)).toBe(true);
  });
});
