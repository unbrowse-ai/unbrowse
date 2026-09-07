/**
 * ISSUE-4 regression — `act run-js` / `act select` / `act click` must have a
 * wall-clock bound.
 *
 * The reported failure: against a live session with a stale lease/target these
 * three never returned and had to be killed externally at 90s, while `act go`,
 * `act fill`, `eval snap` and `eval text` answered normally on the SAME
 * session. `act go` documents `--timeout` (default 30000); these did not.
 *
 * What is simulated here: a target that accepts the crossing and never answers
 * — a promise that never resolves. No browser, no network, no sockets.
 *
 * What is asserted, and why each one is load-bearing:
 *   - the verb RETURNS within the bound            (the hang is fixed)
 *   - it exits NON-ZERO with a `target_lost` error (not a silent truncation —
 *     a bounded verb that reports success for work that never happened is
 *     worse than the hang, because nothing downstream can see it)
 *   - the envelope NAMES the awaited step          (`waiting_on`)
 *   - the default is go.ts's 30000, read out of go.ts itself, so the three
 *     verbs cannot drift away from the flag they are supposed to inherit
 *
 * Falsifier: revert any of the three handlers to the un-bounded call and the
 * corresponding test hangs past its own 3s race and fails on `hung: true`.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ParsedV7Args } from "../src/cli-v7/args.js";

// ── The hanging target: a promise that never settles. ────────────────────────
const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

const FAKE_SESSION = {
  sessionId: "S-stale",
  contextId: "",
  targetId: "T-stale",
  chromeWsUrl: "ws://127.0.0.1:1/devtools/browser/never-dialled",
  chromePid: 424242,
  createdAt: Date.now(),
};

// ── Module mocks. Registered before the handlers are dynamically imported. ───
// `call` never answers = the stale-target condition. `attach`/`attachToTarget`
// succeed, matching the report: the session is live enough that `go`/`fill`
// work, so the WS is up and it is the frame that goes unanswered.
mock.module("../src/cdp/index.js", () => ({
  attach: async () => ({ endpoint: FAKE_SESSION.chromeWsUrl, pid: FAKE_SESSION.chromePid }),
  attachToTarget: async () => ({ sessionId: "flat-1", targetId: FAKE_SESSION.targetId }),
  call: () => NEVER(),
  createTarget: async () => ({ sessionId: "flat-1", targetId: FAKE_SESSION.targetId }),
  spawnChrome: async () => ({ endpoint: FAKE_SESSION.chromeWsUrl, pid: FAKE_SESSION.chromePid }),
}));

mock.module("../src/cli-v7/_session.js", () => ({
  resolveSession: async () => FAKE_SESSION,
  reapStaleSessions: async () => undefined,
  writeSessionRecord: async () => undefined,
}));

mock.module("../src/cli-v7/_breath-audit.js", () => ({
  emitBreathActStateless: async () => ({
    ok: true,
    idempotent: false,
    bindingMissing: false,
    receiptId: "r-1",
    cacheKey: "k-1",
  }),
}));

// select.ts's literal path only needs `looksLikePointer`; stubbing the module
// keeps the value-store/wallet graph out of a test that is about a clock.
mock.module("../src/values/index.js", () => ({
  looksLikePointer: () => false,
  resolve: async () => {
    throw new Error("unused in the literal path");
  },
  safeZero: () => undefined,
}));

mock.module("../src/cli-v7/breath/fill.js", () => ({
  deriveContextHash: () => "00".repeat(32),
}));

// `run-js` delegates to cmdEval, which POSTs /v1/browse/eval with no timeoutMs.
mock.module("../src/cli.js", () => ({
  cmdEval: () => NEVER<void>(),
}));

// ── Harness: run a handler with process.exit and stdout intercepted. ─────────
interface HandlerRun {
  hung: boolean;
  exitCodes: number[];
  stdout: string;
  elapsedMs: number;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * Race the handler against 3s. A handler with no bound never settles, so the
 * race is what turns "hangs forever" into a reportable assertion instead of a
 * bare runner timeout.
 */
async function runHandler(
  handler: (p: ParsedV7Args, o: { json?: boolean }) => Promise<void>,
  parsed: ParsedV7Args,
): Promise<HandlerRun> {
  const exitCodes: number[] = [];
  let stdout = "";

  const realExit = process.exit;
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErrWrite = process.stderr.write.bind(process.stderr);

  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  (process.stderr as unknown as { write: (c: string) => boolean }).write = () => true;

  const started = Date.now();
  const HUNG = Symbol("hung");
  try {
    const outcome = await Promise.race([
      handler(parsed, { json: true }).then(
        () => "returned" as const,
        (err) => (err instanceof ExitSignal ? ("exited" as const) : Promise.reject(err)),
      ),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 3_000)),
    ]);
    return {
      hung: outcome === HUNG,
      exitCodes,
      stdout,
      elapsedMs: Date.now() - started,
    };
  } finally {
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    (process.stderr as unknown as { write: typeof realErrWrite }).write = realErrWrite;
  }
}

/** First JSON line on stdout that carries an `error` field. */
function errorEnvelope(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (typeof v.error === "string") return v;
    } catch {
      /* not a JSON line */
    }
  }
  return null;
}

function args(sub: string, positional: string[], flags: Record<string, string | boolean>): ParsedV7Args {
  return { verb: "breath", sub, positional, flags, wantsHelp: false, wantsJson: true };
}

afterEach(() => {
  // Nothing global to reset beyond what runHandler's finally restores; kept so
  // a future stateful mock has an obvious home.
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the shared bound (_act-deadline)", () => {
  it("rejects with target_lost naming the awaited step, instead of hanging", async () => {
    const { withActDeadline, TargetLostError } = await import(
      "../src/cli-v7/breath/_act-deadline.js"
    );
    const started = Date.now();
    let caught: unknown;
    try {
      await withActDeadline(NEVER<string>(), 120, "DOM.querySelector(#pay-now)");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TargetLostError);
    expect((caught as InstanceType<typeof TargetLostError>).name).toBe("target_lost");
    expect((caught as InstanceType<typeof TargetLostError>).waitingOn).toBe(
      "DOM.querySelector(#pay-now)",
    );
    expect((caught as Error).message).toContain("DOM.querySelector(#pay-now)");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does NOT substitute a value on timeout — a bound must not become a silent success", async () => {
    const { withActDeadline } = await import("../src/cli-v7/breath/_act-deadline.js");
    // The failure mode being excluded: resolving with a fallback (the
    // withDeadline shape used by `close`) would let a verb print ok:true for a
    // click that never landed.
    const settled = await withActDeadline(NEVER<string>(), 60, "x").then(
      (v) => ({ kind: "resolved" as const, v }),
      (e) => ({ kind: "rejected" as const, v: e }),
    );
    expect(settled.kind).toBe("rejected");
  });

  it("passes a real error through untouched and resolves fast work", async () => {
    const { withActDeadline, TargetLostError } = await import(
      "../src/cli-v7/breath/_act-deadline.js"
    );
    await expect(withActDeadline(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
    const err = await withActDeadline(
      Promise.reject(new Error("selector_not_found:#nope")),
      1_000,
      "x",
    ).catch((e) => e);
    expect(err).not.toBeInstanceOf(TargetLostError);
    expect((err as Error).message).toBe("selector_not_found:#nope");
  });

  it("parses --timeout the way auth-capture does, and refuses a NaN clock", async () => {
    const { parseActTimeoutMs, DEFAULT_ACT_TIMEOUT_MS } = await import(
      "../src/cli-v7/breath/_act-deadline.js"
    );
    expect(parseActTimeoutMs({})).toBe(DEFAULT_ACT_TIMEOUT_MS);
    expect(parseActTimeoutMs({ timeout: "5000" })).toBe(5_000);
    // `--timeout` with no value parses as boolean true; a typo'd value must not
    // become setTimeout(NaN), which fires immediately and would look like an
    // instant unexplained target_lost.
    expect(parseActTimeoutMs({ timeout: true })).toBe(DEFAULT_ACT_TIMEOUT_MS);
    expect(parseActTimeoutMs({ timeout: "banana" })).toBe(DEFAULT_ACT_TIMEOUT_MS);
    expect(parseActTimeoutMs({ timeout: "-1" })).toBe(DEFAULT_ACT_TIMEOUT_MS);
  });

  it("inherits go.ts's default, checked against go.ts rather than asserted", async () => {
    const { DEFAULT_ACT_TIMEOUT_MS, TIMEOUT_FLAG_HELP } = await import(
      "../src/cli-v7/breath/_act-deadline.js"
    );
    const goSrc = readFileSync(join(import.meta.dir, "..", "src", "cli-v7", "breath", "go.ts"), "utf8");
    const row = goSrc
      .split("\n")
      .find((l) => l.includes('name: "--timeout"'));
    expect(row).toBeDefined();
    const declared = /default:\s*(\d+)/.exec(row as string)?.[1];
    // go.ts is the source of truth for the flag's default; if someone changes
    // it there, this fails rather than letting the act verbs quietly disagree.
    expect(declared).toBe(String(DEFAULT_ACT_TIMEOUT_MS));
    expect((row as string).includes(TIMEOUT_FLAG_HELP.description)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("breath click — bounded against a target that never answers", () => {
  it("returns target_lost instead of hanging", async () => {
    const { handler } = await import("../src/cli-v7/breath/click.js");
    const run = await runHandler(handler, args("click", ["#pay-now"], { timeout: "250" }));

    expect(run.hung).toBe(false);
    expect(run.elapsedMs).toBeLessThan(3_000);
    expect(run.exitCodes[0]).toBe(69); // EX_TARGET_LOST, not 0
    const env = errorEnvelope(run.stdout);
    expect(env?.error).toBe("target_lost");
    expect(env?.timeout_ms).toBe(250);
    expect(String(env?.waiting_on)).toContain("#pay-now");
    expect(env?.ok).toBe(false);
  }, 10_000);
});

describe("breath select — bounded against a target that never answers", () => {
  it("returns target_lost instead of hanging", async () => {
    const { handler } = await import("../src/cli-v7/breath/select.js");
    const run = await runHandler(
      handler,
      args("select", ["#country", "Singapore"], { timeout: "250" }),
    );

    expect(run.hung).toBe(false);
    expect(run.elapsedMs).toBeLessThan(3_000);
    expect(run.exitCodes[0]).toBe(69);
    const env = errorEnvelope(run.stdout);
    expect(env?.error).toBe("target_lost");
    expect(env?.timeout_ms).toBe(250);
    expect(String(env?.waiting_on)).toContain(FAKE_SESSION.targetId);
  }, 10_000);
});

describe("breath run-js — bounded against an eval that never answers", () => {
  it("returns target_lost instead of hanging", async () => {
    const { handler } = await import("../src/cli-v7/breath/run-js.js");
    const run = await runHandler(
      handler,
      args("run-js", ["JSON.stringify({x:1})"], { timeout: "250" }),
    );

    expect(run.hung).toBe(false);
    expect(run.elapsedMs).toBeLessThan(3_000);
    expect(run.exitCodes[0]).toBe(69);
    const env = errorEnvelope(run.stdout);
    expect(env?.error).toBe("target_lost");
    expect(env?.timeout_ms).toBe(250);
    // Names the expression, not just "eval" — several run-js calls in flight
    // otherwise produce indistinguishable failures.
    expect(String(env?.waiting_on)).toContain("JSON.stringify({x:1})");
  }, 10_000);
});
