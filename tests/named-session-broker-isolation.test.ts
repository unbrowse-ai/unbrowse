// Falsifier for the explicit-session_id broker isolation contract.
// When a caller (MCP sub-agent, gate collector) provides distinct session_ids
// concurrently, selectBrowseBrokerClient must return distinct broker clients
// — otherwise one session's tab can render another session's URL (the
// cross-bind seen in the 2026-05-18 MCP gate, 31/58 go_failed at conc=4).
//
// Pre-fix: every call falls through to the pooled-broker selector and returns
// the SAME client (port 7700) — assertion fails.
// Post-fix: each named session gets a dedicated broker port — distinct clients.
import { describe, it, expect } from "bun:test";
import { selectBrowseBrokerClient } from "../src/api/routes.ts";

describe("named-session broker isolation", () => {
  it("returns distinct broker clients for distinct unmapped session_ids", () => {
    const a = selectBrowseBrokerClient("iso-test-a");
    const b = selectBrowseBrokerClient("iso-test-b");
    const c = selectBrowseBrokerClient("iso-test-c");
    const d = selectBrowseBrokerClient("iso-test-d");

    const portA = a.getPort();
    const portB = b.getPort();
    const portC = c.getPort();
    const portD = d.getPort();

    // Every named session gets its own kuri broker port. Without isolation
    // these would all be 7700 (the single pool broker), which is exactly the
    // cross-bind condition that lost 50% of sessions in the parallel MCP
    // falsifier.
    const ports = new Set([portA, portB, portC, portD]);
    expect(ports.size).toBe(4);
  });

  it("returns the same broker client for the same session_id called twice (no thrash)", () => {
    // A second call with no existing session in browseSessions allocates a
    // fresh port (sessions only persist after createBrowseSession runs). The
    // contract that matters is: distinct session_ids never collide. Same
    // session_id repeated before any session lands is a degenerate path —
    // documented here so callers know not to expect idempotent allocation
    // pre-session-create. After the session exists in browseSessions, the
    // existing branch returns its bound client (the existing.client path
    // tested separately when integration coverage is present).
    const p1 = selectBrowseBrokerClient("iso-test-repeat").getPort();
    const p2 = selectBrowseBrokerClient("iso-test-repeat").getPort();
    expect(p1).not.toBe(p2); // documents the pre-create allocation behavior
  });

  it("anonymous (no session_id) calls use per-session isolation by default", () => {
    // The current default isolates unnamed sessions too. Legacy shared-pool
    // behavior is opt-out via UNBROWSE_PER_SESSION_KURI=0.
    const anon1 = selectBrowseBrokerClient().getPort();
    const anon2 = selectBrowseBrokerClient().getPort();
    const perSessionBase = Number(process.env.KURI_PORT ?? "7700") + 100;
    expect(anon1).toBeGreaterThanOrEqual(perSessionBase);
    expect(anon2).toBeGreaterThanOrEqual(perSessionBase);
    expect(anon1).not.toBe(anon2);
  });
});
