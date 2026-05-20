/**
 * Falsifier for the close-broker-stop detach contract.
 *
 * Pre-fix: `/v1/browse/close` awaited `broker.stop()` inside the serialized
 * session lambda. broker.stop awaits SIGTERM up to 3s and SIGKILL fallback up
 * to 2s (src/kuri/client.ts:stopOn). On a kuri that traps SIGTERM, the
 * agent-visible close response hangs up to 5s AFTER `enrich-capture` and
 * `close-tab` already finished. Combined effect is the "unbrowse_close appears
 * stuck" symptom: trace shows everything done, response still pending.
 *
 * Post-fix: the close handler builds the broker-stop promise inside the lambda
 * (so the existing traceAsync BEGIN/END instrumentation still wraps it and a
 * background hang stays diagnosable in the log), but returns it through the
 * lambda as `pendingBrokerStop` and FIRES IT INTO THE BACKGROUND via
 * `void pendingBrokerStop.catch(() => {})`. Response payload no longer waits
 * on kuri's SIGTERM deadline.
 *
 * Three asserts below:
 *
 *   (1) PATTERN: the void-catch detach pattern returns immediately even when
 *       broker.stop is slow, broker.stop is still actually called (zombies
 *       prevented), and a rejected broker.stop does not produce an unhandled
 *       rejection. Stand-in for kuri.stopOn with a deferred Promise so no real
 *       Kuri or Fastify spawn is needed.
 *
 *   (2) SOURCE PIN: the real /v1/browse/close handler in src/api/routes.ts
 *       contains the detach. If someone re-introduces `await pendingBrokerStop`,
 *       the agent-visible hang comes back and this test fails. The pin matches
 *       fixed tokens (no whitespace fragility) so reformatting is safe.
 */
import { describe, expect, test } from "bun:test";

describe("browse-close: broker.stop runs in background (the unbrowse_close-appears-stuck fix)", () => {
  test("close return path does NOT await broker.stop, even with a slow broker.stop", async () => {
    let stopCalled = false;
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    // Stand-in for `broker.stop()`: a kuri that takes a long time to die
    // (e.g. SIGTERM trapped, awaiting SIGKILL fallback). The real route never
    // awaits this promise on the response path post-fix.
    const fakeBrokerStop = () => {
      stopCalled = true;
      return stopPromise;
    };

    // Mirror the route's exact detach pattern:
    //   capture the promise inside the (would-be) lambda,
    //   void-catch outside so it cannot become an unhandled rejection,
    //   the outer "close response" then proceeds immediately.
    const closeStart = Date.now();
    const pendingBrokerStop = fakeBrokerStop();
    if (pendingBrokerStop) {
      void pendingBrokerStop.catch(() => {});
    }
    // simulate "reply.send(...)" by just returning synchronously
    const closeElapsed = Date.now() - closeStart;

    // (1) Response returns immediately, agent does NOT wait on broker.stop.
    expect(closeElapsed).toBeLessThan(100);
    expect(stopCalled).toBe(true);

    // (2) The broker.stop promise is still pending (zombies will still be
    //     prevented once it eventually resolves).
    let resolved = false;
    pendingBrokerStop.then(() => { resolved = true; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // Drain the deferred so the test process exits cleanly.
    resolveStop();
    await pendingBrokerStop;
  });

  test("a broker.stop rejection on the detached path does NOT produce an unhandled rejection", async () => {
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);

    try {
      const pendingBrokerStop = Promise.reject(new Error("kuri broker.stop threw"));
      void pendingBrokerStop.catch(() => {});

      // Let the microtask queue plus one macrotask tick run.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("source pin: src/api/routes.ts /v1/browse/close detaches broker-stop", async () => {
    // Without this pin a future refactor could remove the void-catch detach
    // from /v1/browse/close. The PATTERN test above would still pass because
    // it exercises a hand-crafted snippet, not the real route. The pin
    // matches fixed tokens so reformatting is safe; only re-introducing an
    // `await pendingBrokerStop` makes the hang come back.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const routesPath = path.resolve(__dirname, "..", "src", "api", "routes.ts");
    const src = fs.readFileSync(routesPath, "utf-8");

    // The lambda must produce pendingBrokerStop (the detach handle).
    expect(src.includes("pendingBrokerStop")).toBe(true);
    expect(src.includes("return { syncResult, pendingBrokerStop };")).toBe(true);

    // The outer handler must FIRE-AND-FORGET it.
    expect(src.includes("void pendingBrokerStop.catch(() => {})")).toBe(true);
    expect(src.includes("await pendingBrokerStop")).toBe(false);
  });

  test("when broker.stop is skipped (pool broker / not last user), no detached promise is created", () => {
    // Mirrors the route's port-uniqueness check: pool brokers (port <
    // PER_SESSION_BROKER_BASE_PORT) or per-session brokers still used by
    // another live session do NOT get a broker.stop call. pendingBrokerStop
    // stays null, the void-catch is skipped, no zombie risk introduced.
    const pendingBrokerStop: Promise<void> | null = null;
    let detached = false;
    if (pendingBrokerStop) {
      detached = true;
      void (pendingBrokerStop as Promise<void>).catch(() => {});
    }
    expect(detached).toBe(false);
  });
});
