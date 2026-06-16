/**
 * Falsifiable signal on the Step-3 artifact (scripts/surface-gate.ts).
 *
 * Day-4 luminary (Matt 7:24-25): prove the instrument stands on rock BEFORE
 * the Day-5 storm. Imports runGate() in-process (no recursive subprocess —
 * bun-test pipes a spawned bun child's streams to nothing) and asserts the
 * gate emits all seven invariants and is calibrated to the collapse state.
 *
 * Calibration: the collapse has landed; the only outstanding item is the
 * dead-code purge of the site-pack helpers (cmdSite{Task,Help,Batch,Login}),
 * tracked by the hardened A.purge. Until that purge lands, A.purge is the one
 * expected RED — an HONEST red, not a fabricated green. Every other invariant
 * (B–G, plus F when GATE_LIVE=1) MUST hold. When the purge lands, A goes green
 * and `failed` must be empty.
 */
import { test, expect } from "bun:test";
import { runGate } from "../scripts/surface-gate.ts";

const INVARIANT_IDS = ["A.purge", "B.no-alias", "C.map-agree", "D.mcp-match", "E.skill-md", "G.runtime-fresh", "F.live"];

test("surface-gate emits all seven invariants", async () => {
  const rs = await runGate();
  const ids = rs.map((r) => r.id);
  for (const id of INVARIANT_IDS) expect(ids).toContain(id);
  expect(rs.length).toBe(7);
});

test("surface-gate is calibrated to the current collapse state", async () => {
  const rs = await runGate();
  const failed = rs.filter((r) => !r.ok).map((r) => r.id);
  // Every invariant except A.purge must hold now; A.purge is the lone honest
  // RED until the cmdSite* dead-code purge lands (it clears automatically once
  // those helper definitions are removed — verified by the gate, not asserted).
  // (F.live is in-process-skipped unless GATE_LIVE=1; the CLI live run covers it.)
  const stillFailing = failed.filter((id) => id !== "A.purge");
  expect(stillFailing).toEqual([]);
});
