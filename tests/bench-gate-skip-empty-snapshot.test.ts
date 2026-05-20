// UNBROWSE_GATE_SKIP_EMPTY_SNAPSHOT=1 lets the bench-gate stop-on-fail loop
// advance past kuri/SPA hydration-race probes (the empty_snapshot block
// signal where eval also returned undefined) to surface OTHER bugs the
// loop is meant to fix. The artifact still records the signal; this only
// changes whether STOP_ON_FAIL halts.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "scripts/mcp-gate-parallel-collect.ts"), "utf8");

describe("bench-gate SKIP_EMPTY_SNAPSHOT flag", () => {
  it("declares the SKIP_EMPTY_SNAPSHOT env flag", () => {
    expect(SRC).toMatch(/UNBROWSE_GATE_SKIP_EMPTY_SNAPSHOT/);
    expect(SRC).toMatch(/const SKIP_EMPTY_SNAPSHOT =/);
  });

  it("predicate honors SKIP_EMPTY_SNAPSHOT for both empty_snapshot and go_failed browser-infra failures", () => {
    expect(SRC).toMatch(/isEmptySnapshotOnly/);
    expect(SRC).toMatch(/isGoFailed/);
    expect(SRC).toMatch(/SKIP_EMPTY_SNAPSHOT && \(isEmptySnapshotOnly \|\| isGoFailed\)/);
    // empty_snapshot signature: indexed=false + n_ops=0 + mode=none + browser_block_signals=["empty_snapshot"].
    expect(SRC).toMatch(/!indexed && nOps === 0/);
    expect(SRC).toMatch(/cm\?\.mode === "none"/);
    expect(SRC).toMatch(/browser_block_signals\[0\] === "empty_snapshot"/);
    // go_failed signature: snap_current_url=null + index.store.reason="go_failed".
    expect(SRC).toMatch(/idxStore\?\.reason === "go_failed"/);
    expect(SRC).toMatch(/iso_self_check\?\.snap_current_url == null/);
  });
});
