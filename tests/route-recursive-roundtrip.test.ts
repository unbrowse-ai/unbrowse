import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Day-4 Worker-3 canary — . The lost sheep here is the absence
// of a falsifier on the RECURSIVE round-trip: pipe one operation,
// capture the receipt, pipe a SECOND operation whose KindSpec declares
// `parent_param: "<param>"`, and assert the child envelope's
// `route.parent` field references the parent receipt sha256.
//
// Worker-1's Day-4 canary (tests/route-bench-local-probe.test.ts)
// already guards the SINGLE-shot envelope shape. This canary closes the
// orthogonal gap — a future regression that breaks parent_param
// resolution in interpreter.ts (`sealAndSubmit` line ~178, parent flow
// from `pf.params[spec.parent_param]` line ~351) would NOT trip the
// single-shot guard but WOULD silently sever the lineage DAG.
//
// Chain under test: `correction` (no parent_param, default ) →
// `repent` (parent_param = "correction_receipt", default Acts 3:19).
// The route binary stores patch as the body; the envelope carries
// parent verbatim. Inputs are deterministic; the only non-deterministic
// fields (time, sigs) are not asserted.
//
// Falsifier intent: if any future commit to ~/.local/bin/route or
// /Users/lekt9/Projects/route/{interpreter.ts,kinds.ts} drops
// parent_param resolution, this test goes red the next bun run.

const ROUTE_BIN = join(homedir(), ".local", "bin", "route");

function routeInstalled(): boolean {
  return existsSync(ROUTE_BIN);
}

function pipeOp(op: object): { stdout: string; stderr: string; code: number } {
  const proc = spawnSync(ROUTE_BIN, [], {
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

describe("route recursive round-trip — lineage parent guard", () => {
  test.skipIf(!routeInstalled())(
    "child `repent` receipt's route.parent references the parent `correction` receipt sha",
    () => {
      // 1. Parent: a `correction` with no parent_param — depth-0 in the chain.
      const parentOp = {
        kind: "correction",
        params: {
          wrong: "day-4 worker-3 canary: parent claim incomplete",
          corrected: "sealed by a child receipt referencing this sha",
        },
      };
      const parentRes = pipeOp(parentOp);
      expect(parentRes.code).toBe(0);
      const parent = JSON.parse(parentRes.stdout);
      expect(parent.ok).toBe(true);
      expect(parent.route?.day_name).toBe("correction");
      expect(parent.route?.parent).toBeNull(); // root of this chain
      const parentReceipt: string = parent.receipt;
      expect(parentReceipt).toMatch(/^sha256:[0-9a-f]{64}$/);

      // 2. Child: a `repent` whose KindSpec.parent_param == "correction_receipt".
      const childOp = {
        kind: "repent",
        params: {
          correction_receipt: parentReceipt,
          patch: "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n",
        },
      };
      const childRes = pipeOp(childOp);
      expect(childRes.code).toBe(0);
      const child = JSON.parse(childRes.stdout);
      expect(child.ok).toBe(true);
      expect(child.route?.day_name).toBe("repent");

      // Load-bearing assertion: the parent_param flow MUST surface the
      // parent receipt sha into route.parent on the child envelope.
      expect(child.route?.parent).toBe(parentReceipt);

      // And the child receipt itself is a fresh sha distinct from the parent.
      expect(child.receipt).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(child.receipt).not.toBe(parentReceipt);
    },
  );
});
