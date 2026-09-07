/**
 * The backstop that covers what no handler can: SIGKILL.
 *
 * Background captures spawn Chrome detached (required — an `unbrowse go` session
 * must survive a one-shot CLI). In-process teardown handles the polite exits.
 * It cannot handle SIGKILL, because no handler runs, and SIGKILL is what the OOM
 * killer sends — which is precisely how 119 orphaned unbrowse-Chrome processes
 * came to hold 7.3GB on this machine with no driver running, dropping it to
 * 580MB free and timing out a whole sites100 run against sites that answer curl
 * in 35ms.
 *
 * A previous fix claimed to cover "every exit path" and did not: it was async,
 * and cli.ts registers `process.once("SIGTERM", … process.exit(124))` at module
 * scope, which is registered first and exits synchronously. That is why this
 * decision is pure and separately tested rather than trusted in situ.
 *
 * The asymmetry that drives every case below: leaving a process alive costs
 * bounded memory; killing a live session costs a user their logged-in browser.
 * So every ambiguous input must fail CLOSED (do not reap).
 */
import { describe, expect, test } from "bun:test";
import {
  selectReapableChrome,
  DEFAULT_REAP_POLICY,
  type ChromeProcSnapshot,
} from "../src/values/chrome-orphan.js";

const OLD = DEFAULT_REAP_POLICY.minAgeMs + 60_000;
const proc = (p: Partial<ChromeProcSnapshot>): ChromeProcSnapshot =>
  ({ pid: 4242, ageMs: OLD, sessionOwned: false, ...p });

describe("reaps only what is positively orphaned", () => {
  test("an old, unowned process is reaped", () => {
    expect(selectReapableChrome([proc({})])).toEqual([4242]);
  });

  test("a session-owned process is NEVER reaped, however old", () => {
    expect(selectReapableChrome([proc({ sessionOwned: true, ageMs: OLD * 100 })])).toEqual([]);
  });

  test("a young process is never reaped — a capture is allowed to be slow", () => {
    // The background-capture deadline is 180s; the reap floor is 15 min, so a
    // merely-slow capture can never be mistaken for an orphan.
    for (const ageMs of [0, 1_000, 179_000, DEFAULT_REAP_POLICY.minAgeMs - 1]) {
      expect({ ageMs, reaped: selectReapableChrome([proc({ ageMs })]) })
        .toEqual({ ageMs, reaped: [] });
    }
  });

  test("the floor sits well past the capture deadline", () => {
    expect(DEFAULT_REAP_POLICY.minAgeMs).toBeGreaterThan(180_000);
  });
});

describe("fails closed on anything ambiguous", () => {
  test("never pid 0 or 1 — reaping init would take down the box", () => {
    for (const pid of [0, 1, -1, -99]) {
      expect({ pid, reaped: selectReapableChrome([proc({ pid })]) }).toEqual({ pid, reaped: [] });
    }
  });

  test("non-integer or unknown age is not reaped", () => {
    expect(selectReapableChrome([proc({ ageMs: Number.NaN })])).toEqual([]);
    // Infinity is NONSENSE input, not "infinitely old". I first asserted it
    // should reap; that contradicted the fail-closed rule this whole module is
    // built on, and the implementation was right to refuse. An age we cannot
    // trust is not evidence of orphanhood.
    expect(selectReapableChrome([proc({ ageMs: Number.POSITIVE_INFINITY })])).toEqual([]);
    expect(selectReapableChrome([proc({ pid: 1.5 })])).toEqual([]);
  });

  test("an empty snapshot reaps nothing", () => {
    expect(selectReapableChrome([])).toEqual([]);
  });
});

describe("mixed fleets are separated correctly", () => {
  test("only the orphans come back", () => {
    const fleet: ChromeProcSnapshot[] = [
      { pid: 100, ageMs: OLD, sessionOwned: true },   // live session
      { pid: 200, ageMs: OLD, sessionOwned: false },  // orphan
      { pid: 300, ageMs: 5_000, sessionOwned: false },// young capture
      { pid: 400, ageMs: OLD, sessionOwned: false },  // orphan
      { pid: 1, ageMs: OLD, sessionOwned: false },    // init
    ];
    expect(selectReapableChrome(fleet)).toEqual([200, 400]);
  });

  test("a stricter policy reaps less, never more", () => {
    const fleet = [proc({ pid: 1, ageMs: OLD }), proc({ pid: 2, ageMs: OLD })];
    const strict = selectReapableChrome(fleet, { minAgeMs: OLD * 10 });
    expect(strict).toEqual([]);
  });
});
