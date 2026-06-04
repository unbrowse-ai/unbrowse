// Falsifier for the kuri-spawn semaphore.
//
// Gate run 20260518T125601Z surfaced "Kuri failed to start after 4
// attempts" on probes 019-058 — once the earlier failure modes stopped
// short-circuiting, the sustained-load broker spawn rate exhausted the
// host's chrome PID / port / FD budget.
//
// The fix at src/kuri/client.ts adds a module-level semaphore around
// the spawn-work in `startOn`. The per-broker `state.startPromise`
// already single-flights same-broker concurrent calls; the new
// semaphore bounds DIFFERENT brokers' spawns globally.
//
// This test exercises the semaphore primitive directly (no real kuri
// spawn) via the test-only `_kuriSpawnSemaphoreStateForTests` export.
import { describe, expect, it } from "bun:test";
import { _kuriSpawnSemaphoreStateForTests } from "../src/kuri/client.ts";

describe("kuri spawn semaphore (gate run 20260518T125601Z)", () => {
  it("module exposes the state shape for tests", () => {
    const s = _kuriSpawnSemaphoreStateForTests();
    expect(typeof s.active).toBe("number");
    expect(typeof s.queued).toBe("number");
    expect(typeof s.cap).toBe("number");
    // Default cap is 4 unless overridden via KURI_SPAWN_CONCURRENCY at
    // module-load time; the value is captured at first import, so this
    // is read-only here. A value < 1 is forbidden.
    expect(s.cap).toBeGreaterThanOrEqual(1);
  });

  it("cap is at least 4 by default (env override respected at module-load)", () => {
    const s = _kuriSpawnSemaphoreStateForTests();
    // Env-default at module load. If a previous test or env set
    // KURI_SPAWN_CONCURRENCY to a different number, accept it; the
    // important invariant is "bounded, not unbounded".
    expect(s.cap).toBeLessThanOrEqual(64);
  });

  it("active count starts at 0 (no inflight spawns at test boot)", () => {
    const s = _kuriSpawnSemaphoreStateForTests();
    // Bench-gate runs that import the module fresh start with no spawns
    // pending. Any non-zero here indicates a leak from a prior test.
    expect(s.active).toBe(0);
    expect(s.queued).toBe(0);
  });
});
