/**
 * U-4 repro: `act capture` must NOT tear down a running `act serve` daemon.
 *
 * MECHANISM (verified in src/kuri/client.ts):
 *   `act serve` spawns the Kuri broker and listens on its port. When
 *   `act capture` runs in a SEPARATE process, its in-process BrokerState has
 *   `process: null` (it did not spawn that broker). The acquisition path calls
 *   `reuseHealthyBrokerIfPossible`. The broker is healthy, but capture's state
 *   has no CDP / no registered tabs, so the OLD code fell to a "recycle" branch
 *   that, because `state.process == null`, called `terminateBrokerOnPort(port)` —
 *   `lsof`-ing the broker port and SIGTERM'ing the LISTENER. That listener is the
 *   serve daemon. => capture killed serve (U-4).
 *
 * FIX: a healthy broker with no process handle is FOREIGN (owned by another
 * process). It is never terminated by port. In attach mode it is reused
 * cooperatively; in clean-room it is left alone while capture spawns its own.
 *
 * WHY NOT a full two-daemon live test: starting two real `unbrowse act` daemons
 * + two managed Chromes on a CI box is slow and flaky (chrome launch, port
 * races, host PID limits). Instead we drive the EXACT acquisition function the
 * real capture path calls, against a stand-in BrokerState for serve's foreign
 * broker, and assert the concrete code invariant the fix establishes: the
 * port-kill path is NEVER invoked for a broker this process does not own. That
 * is the precise, falsifiable invariant — if a future change reintroduces the
 * lsof-on-port kill, `terminate-broker` fires and this test goes red.
 */
import { describe, expect, it } from "bun:test";
import * as kuri from "../src/kuri/client.js";

describe("U-4 — act capture must not kill a running act serve daemon", () => {
  // Build a BrokerState representing what `act capture` sees: a HEALTHY broker
  // (serve's daemon is listening) that capture did NOT spawn (process: null) and
  // for which capture has no live CDP / no registered tabs.
  function captureFacingForeignBrokerState() {
    return {
      process: null, // capture did not spawn this broker — serve owns it
      port: 6969, // serve's broker port
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 6969,
    };
  }

  it("U-4: capture reuses serve's foreign broker in attach mode and NEVER terminates it by port", async () => {
    const seen: string[] = [];
    const state = captureFacingForeignBrokerState();

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true, // serve's daemon is alive on the port
        discoverCdpPort: async () => { seen.push("discover-cdp"); },
        ensureUserChromeRunning: async () => { seen.push("ensure-user-chrome"); },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [], // capture sees no tabs of its own
        // The serve-killing path. The whole point of U-4: this must NOT fire.
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    // serve's broker stays up and capture cooperates with it.
    expect(reused).toBe(true);
    expect(state.ready).toBe(true);
    // The load-bearing invariant: the foreign daemon is never SIGTERM'd by port.
    expect(seen).not.toContain("terminate-broker");
  });

  it("U-4: capture in clean-room mode leaves serve's foreign broker alive (no port-kill)", async () => {
    const seen: string[] = [];
    const state = captureFacingForeignBrokerState();

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: true, attachToExistingChrome: false }, // clean-room / isolated
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async (s) => { seen.push("discover-cdp"); s.cdpPort = 9223; },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    // Clean-room won't share the foreign broker, but it must still not kill it —
    // it returns false so the spawn path brings up capture's OWN broker.
    expect(reused).toBe(false);
    expect(seen).not.toContain("terminate-broker");
  });

  it("U-4: a SELF-OWNED broker is recycled via its own child handle, never by lsof-on-port", async () => {
    // Distinguishes the fix from a blanket "never recycle": a broker THIS process
    // spawned (live child handle) whose CDP+tabs are gone is still torn down — but
    // via the child handle (SIGTERM on the process we own), never by killing the
    // listener on the port. This is what makes capture safe without disabling
    // legitimate self-recycle.
    const seen: string[] = [];
    let killedOwnChild = false;
    const fakeChild = {
      kill: () => { killedOwnChild = true; return true; },
      exitCode: 0,
      signalCode: null,
      once: (_e: string, cb: () => void) => { cb(); },
      on: (_e: string, cb: () => void) => { cb(); },
    };
    const state = {
      process: fakeChild,
      port: 6969,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 6969,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async () => {},
        ensureUserChromeRunning: async () => {},
        ensureTabsDiscovered: async () => {},
        listTabs: async () => [],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    expect(reused).toBe(false);
    expect(killedOwnChild).toBe(true); // recycled via the handle we own
    expect(seen).not.toContain("terminate-broker"); // never by lsof-on-port
  });
});
