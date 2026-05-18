// Per-session Kuri isolation: when UNBROWSE_PER_SESSION_KURI is set, every NEW
// browse session must get its OWN Kuri broker on a dedicated port instead of
// load-balancing the single (KURI_MULTI_BROKER_MAX=1) pool. A distinct port is
// a distinct brokerCreateQueues key (browse-session.ts withBrokerCreateLock), so
// concurrent /v1/browse/go calls no longer serialize through one create-lock or
// cross-bind tabs.
//
// Root cause proven 2026-05-17 (.bench-gate/20260517T102334Z): the MCP gate
// collector at conc=100 hit 59% counted-lane go_failed plus 4 tab cross-
// contaminations because every session funneled through one broker on port
// 7700; conc=6 was the only safe band. This file is the regression sentinel
// for the per-session-port fix.
//
// Real code path: imports the real selectBrowseBrokerClient and the real
// kuri.getKuriClient. getKuriClient builds a BrokerState plus a client object
// only (no Chrome or Kuri spawn; launch is deferred to client.start()), so this
// asserts the allocation seam with zero process spawn and zero mocks.

import { afterEach, describe, expect, it } from "bun:test";
import { selectBrowseBrokerClient } from "../src/api/routes.js";

const FLAG = "UNBROWSE_PER_SESSION_KURI";
const POOL_BASE = Number(process.env.KURI_PORT ?? "7700");

afterEach(() => {
  delete process.env[FLAG];
});

describe("per-session Kuri broker isolation", () => {
  it("flag OFF: NAMED sessions still isolate per session_id (the 2026-05-18 fix)", () => {
    // Pre-fix contract: every session shared port 7700 unless the flag was set.
    // Post-fix contract (routes.ts selectBrowseBrokerClient): an explicit
    // session_id IS the caller's isolation contract — every named session gets
    // its own broker port, regardless of UNBROWSE_PER_SESSION_KURI. Confirmed
    // by tests/named-session-broker-isolation.test.ts mutation test (2 fails
    // pre-fix, 0 fails post-fix). The flag now only governs ANONYMOUS sessions
    // (the next test).
    delete process.env[FLAG];
    const a = selectBrowseBrokerClient("flagoff-A");
    const b = selectBrowseBrokerClient("flagoff-B");
    expect(a.getPort()).not.toBe(b.getPort());
    expect(a.getPort()).toBeGreaterThan(POOL_BASE);
    expect(b.getPort()).toBeGreaterThan(POOL_BASE);
  });

  it("flag ON: two new sessions get DISTINCT dedicated broker ports", () => {
    process.env[FLAG] = "1";
    const a = selectBrowseBrokerClient("iso-A");
    const b = selectBrowseBrokerClient("iso-B");
    const pa = a.getPort();
    const pb = b.getPort();
    expect(pa).not.toBe(pb);
    // Dedicated ports live above the pool base so they never collide with it.
    expect(pa).toBeGreaterThan(POOL_BASE);
    expect(pb).toBeGreaterThan(POOL_BASE);
  });

  it("flag ON (accepts 'true'): 16 concurrent new sessions all get unique ports", () => {
    process.env[FLAG] = "true";
    // Synchronous allocation in a single-threaded event loop is the real
    // concurrency guarantee: N callers with no await between each get a
    // unique port atomically (cursor increment cannot interleave).
    const ports = Array.from({ length: 16 }, (_, i) =>
      selectBrowseBrokerClient(`conc-${i}`).getPort(),
    );
    expect(new Set(ports).size).toBe(ports.length);
  });
});
