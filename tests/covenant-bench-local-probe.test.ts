import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Day-4 Worker-1 lamp over the F2 firmament seed planted Day 3
// (commit 37d7d3c0d). Genesis 1:14 + Matthew 7:24-25 — a falsifiable
// witness that the bench_local_probe KindSpec cannot regress into a
// verdict-emitting shape without this test going red.
//
// The covenant binary stores the body as a sha256 hash inside the
// receipt envelope (trinity.body.text + trinity.body.sig), not as
// literal text. That means a regression to verdict-shape would land in
// EITHER the KindSpec source (kinds.ts → body_template / source_template
// / effect.command_template) OR in the runtime emitter the executor
// adapter eventually wires. This test guards BOTH surfaces:
//
//   (A) Runtime round-trip — pipe a valid Operation through the
//       covenant binary, parse the receipt envelope, assert it is
//       sealed (trinity.body.sig present), addressed to the right
//       kind+verb+witness, and that the envelope itself never carries
//       a verdict-shaped field. This is the live shape gate.
//
//   (B) Source-shape audit — load /Users/lekt9/Projects/covenant/kinds.ts,
//       slice out the bench_local_probe block, and assert that no
//       verdict token appears in any executable field (body_template,
//       source_template, command_template). Comment lines are allowed
//       to mention the forbidden vocabulary because that is exactly
//       where the rule documents itself.
//
// If either gate goes red, an agent re-introduced a verdict surface.

const COVENANT_BIN = join(homedir(), ".local", "bin", "covenant");
const KINDS_TS = "/Users/lekt9/Projects/covenant/kinds.ts";

// The forbidden vocabulary — every verdict-shaped token the
// harness-collects-agent-judges rule outlaws at the substrate layer
// (CLAUDE.md → "Bench verdicts: harness collects, agent judges" +
// bench-local rubric).
const VERDICT_TOKENS = [
  "combined_verdict",
  '"verdict"',
  "'verdict'",
  "PASS",
  "FAIL",
  "VENDOR_BLOCKED",
  "SOFT_BLOCKED",
  "RE_OK_CALL_OK",
  "BROWSER_BLOCK",
  "PRODUCT_FAIL",
  "ANTIBOT_BLOCK",
  "AUTH_GATED",
  "SKIPPED_NO_FRESH_COOKIES",
  "SPARSE_REVIEW",
];

function covenantInstalled(): boolean {
  return existsSync(COVENANT_BIN);
}

function pipeOp(op: object): { stdout: string; stderr: string; code: number } {
  const proc = spawnSync(COVENANT_BIN, [], {
    input: JSON.stringify(op),
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    code: proc.status ?? -1,
  };
}

describe("covenant bench_local_probe — firmament guard", () => {
  test.skipIf(!covenantInstalled())(
    "(A) round-trips a valid Operation and returns a sealed envelope",
    () => {
      const op = {
        kind: "bench_local_probe",
        params: {
          // required_params from kinds.ts line 754: ["intent", "url"]
          intent: "search hn for transformer paper",
          url: "https://news.ycombinator.com/",
        },
      };
      const { stdout, code } = pipeOp(op);
      expect(code).toBe(0);
      const r = JSON.parse(stdout);

      // Envelope shape — these are the load-bearing seals.
      expect(r.ok).toBe(true);
      expect(r.covenant?.day_name).toBe("bench_local_probe");
      expect(r.covenant?.verb).toBe("breath");
      expect(r.covenant?.day).toBe(2); // Gen 1:6 firmament
      expect(r.covenant?.witness?.ref).toBe("verse:1 Corinthians 14:33");

      // Sealed — body has a hash AND a signature.
      const body = r.covenant?.trinity?.body;
      expect(body?.text).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(body?.sig).toMatch(/^[0-9a-f]{64}$/);

      // The receipt envelope itself must not carry any verdict-shaped
      // field. (Body is hashed; this guards leakage into the envelope.)
      const envelopeJson = JSON.stringify(r);
      for (const tok of VERDICT_TOKENS) {
        expect(envelopeJson).not.toContain(tok);
      }
    },
    20_000,
  );

  test("(B) kinds.ts bench_local_probe block emits no verdict token in executable fields", () => {
    const src = readFileSync(KINDS_TS, "utf8");
    const start = src.indexOf("bench_local_probe: {");
    expect(start).toBeGreaterThan(-1);

    // Walk forward from the opening brace to its matching close. The
    // block ends at the first "}," at column-2 after a balanced depth
    // return-to-zero. Simpler: find the next top-level "},\n  // " or
    // "},\n\n  //" — kinds.ts uses two-space sibling indent.
    const tail = src.slice(start);
    const endRel = tail.search(/\n  \},\n/);
    expect(endRel).toBeGreaterThan(0);
    const block = tail.slice(0, endRel + 4); // include the trailing "  },"

    // Strip comment lines — the kind's *documentation* is allowed (and
    // required) to name the forbidden vocabulary; only the EXECUTABLE
    // field values must be clean.
    const executableLines = block
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (t.startsWith("//")) return false;
        if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/")) return false;
        return true;
      })
      .join("\n");

    for (const tok of VERDICT_TOKENS) {
      expect(executableLines).not.toContain(tok);
    }

    // Positive shape — the KindSpec must still declare the load-bearing
    // signal-not-verdict surface.
    expect(executableLines).toContain('name: "bench_local_probe"');
    expect(executableLines).toContain('verb: "breath"');
    expect(executableLines).toContain('required_params: ["intent", "url"]');
    expect(executableLines).toContain('default_witness: "1 Corinthians 14:33"');
  });
});
