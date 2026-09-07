/**
 * ISSUE-2 + ISSUE-4 regression for `act go` — the two ways it reported work it
 * had not done.
 *
 * Defect A (ISSUE-2): `act go --session S` ignored `--session` outright. It was
 * the only breath verb that never read `parsed.flags.session`, so it always
 * spawned a browser with a fresh temp profile and opened a NEW tab in it. A
 * login performed inside session S (`act fill` + `act submit`, confirmed by
 * `eval text`) was therefore gone by the next `act go` in that same session —
 * and the failure was silent: `cookies_injected: 0` and a valid-looking 404,
 * never an error.
 *
 * Defect B (ISSUE-4): `--timeout` was documented at 30000 in go.ts's own help
 * block and never read. The only real bound was a hardcoded `Date.now() + 6000`
 * readyState poll, so `--timeout 120000` bought six seconds.
 *
 * What is simulated: the whole CDP surface, the session store, the audit
 * receipt and browser-cookie extraction — all handed to `handler` through its
 * `GoDeps` parameter. No browser, no network, no real cookie store: `fetch` is
 * replaced with a stub that records and REFUSES every outbound call, and every
 * cookie here is a synthetic fixture on 127.0.0.1.
 *
 * Deliberately NO `mock.module`. It is process-wide in bun, so two test files
 * faking `src/cdp/index.js` differently overwrite each other and the loser's
 * gate goes red for a reason unrelated to its own code — which is how this file
 * broke tests/breath-act-wall-clock-bound.test.ts before the seam existed.
 *
 * Falsifier, per defect:
 *   A — restore `createTarget(conn, url, {})` on the `--session` path and
 *       "navigates the session's existing tab" goes red on createTarget_calls;
 *       restore the unfiltered `Network.setCookies` and "does not write a stale
 *       browser-profile copy over the cookie the login just set" goes red on
 *       the injected cookie names.
 *   B — restore `const deadline = Date.now() + 6000` and the poll stops scaling
 *       with the flag: both runs take ~6s, the difference collapses to ~0, and
 *       "scales with --timeout" goes red on both of its assertions.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ParsedV7Args } from "../src/cli-v7/args.js";
import type { GoDeps } from "../src/cli-v7/breath/go.js";

// ─── Fixtures. Synthetic throughout; nothing here comes from a real profile. ──
const WS = "ws://127.0.0.1:9/devtools/browser/fixture";
const PID = 999_001;
const URL_PRIVATE = "http://127.0.0.1:3000/private-page";

const FAKE_SESSION = {
  sessionId: "S-live",
  contextId: "",
  targetId: "T-logged-in",
  chromeWsUrl: WS,
  chromePid: PID,
  createdAt: 1_700_000_000_000,
};

/** What the SERVER set in the tab during the interactive login. */
const LIVE_JAR = [
  { name: "fixture_session", value: "LIVE-set-by-server-during-login" },
  { name: "fixture_csrf", value: "LIVE-csrf" },
];

/**
 * What a daily-driver browser profile yields for the same host: an older copy
 * of the same session cookie (it predates the login that just happened in the
 * tab) plus one name the jar does not have.
 */
const EXTRACTED = [
  { name: "fixture_session", value: "STALE-from-browser-profile", domain: "127.0.0.1", path: "/", secure: false, httpOnly: true, sameSite: "lax", expires: 0 },
  { name: "fixture_remember", value: "FIXTURE-remember", domain: "127.0.0.1", path: "/", secure: false, httpOnly: false, sameSite: "lax", expires: 0 },
];

/** A JSON body keeps the direct-fetch supplement out of the way (it only fires
 *  when page.text does NOT decode to a JSON record). */
const PAGE_TEXT = '{"dashboard":"authenticated"}';

// ─── Simulated CDP. Every call is recorded; behaviour is switched per test. ───
interface CdpCall {
  method: string;
  params: Record<string, unknown> | undefined;
  sessionId: string | undefined;
}

const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

const spy = {
  calls: [] as CdpCall[],
  attachEndpoints: [] as string[],
  attachedTargets: [] as string[],
  createdTargets: 0,
  createdTargetUrls: [] as string[],
  spawns: 0,
  reaps: 0,
  written: [] as Array<Record<string, unknown>>,
  /** Every outbound URL the handler tried. All of them are refused. */
  fetched: [] as string[],
};

/** Per-test switches. */
const cfg = {
  readyState: "complete" as string,
  jarReadable: true,
  hangOn: null as string | null,
  sessionKnown: true,
};

function reset(): void {
  spy.calls = [];
  spy.attachEndpoints = [];
  spy.attachedTargets = [];
  spy.createdTargets = 0;
  spy.createdTargetUrls = [];
  spy.spawns = 0;
  spy.reaps = 0;
  spy.written = [];
  spy.fetched = [];
  cfg.readyState = "complete";
  cfg.jarReadable = true;
  cfg.hangOn = null;
  cfg.sessionKnown = true;
}

function fakeConn(): Record<string, unknown> {
  return {
    endpoint: WS,
    pid: PID,
    call: async (method: string, params: Record<string, unknown>, sessionId?: string) => {
      spy.calls.push({ method, params, sessionId });
      if (cfg.hangOn && method === cfg.hangOn) return NEVER();
      if (method === "Network.getCookies") {
        if (!cfg.jarReadable) throw new Error("Network.getCookies: domain not enabled");
        return { cookies: LIVE_JAR.map((c) => ({ ...c })) };
      }
      if (method === "Runtime.evaluate") {
        const expr = String(params?.expression ?? "");
        if (expr === "document.readyState") return { result: { value: cfg.readyState } };
        if (expr === "location.href") return { result: { value: URL_PRIVATE } };
        return { result: { value: PAGE_TEXT } };
      }
      return {};
    },
  };
}

/** The whole outside world `go` touches, as the parameter it now takes. */
function deps(): GoDeps {
  return {
    attach: (async (endpoint: string) => {
      spy.attachEndpoints.push(endpoint);
      return fakeConn();
    }) as unknown as GoDeps["attach"],
    attachToTarget: (async (_conn: unknown, targetId: string) => {
      spy.attachedTargets.push(targetId);
      return { targetId, sessionId: "flat-existing", type: "page" };
    }) as unknown as GoDeps["attachToTarget"],
    createTarget: (async (_conn: unknown, targetUrl: string) => {
      spy.createdTargets += 1;
      spy.createdTargetUrls.push(targetUrl);
      return { targetId: "T-fresh", sessionId: "flat-fresh", type: "page" };
    }) as unknown as GoDeps["createTarget"],
    spawnChrome: (async () => {
      spy.spawns += 1;
      return fakeConn();
    }) as unknown as GoDeps["spawnChrome"],
    resolveSession: (async (id: string | undefined) => {
      if (!cfg.sessionKnown) {
        const err = new Error("session_expired") as Error & { code?: string };
        err.code = "session_expired";
        throw err;
      }
      return { ...FAKE_SESSION, sessionId: id ?? FAKE_SESSION.sessionId };
    }) as unknown as GoDeps["resolveSession"],
    reapStaleSessions: (async () => {
      spy.reaps += 1;
      return 0;
    }) as unknown as GoDeps["reapStaleSessions"],
    writeSessionRecord: (async (rec: Record<string, unknown>) => {
      spy.written.push(rec);
      return "/dev/null";
    }) as unknown as GoDeps["writeSessionRecord"],
    emitBreathAct: (async () => ({
      ok: true,
      skipped: false,
      idempotent: false,
      bindingMissing: undefined,
      receiptId: "r-1",
      cacheKey: "k-1",
      httpStatus: 200,
    })) as unknown as GoDeps["emitBreathAct"],
    // The real module reads THIS machine's browser profiles. It is never loaded.
    loadBrowserCookies: async () => ({
      findBestBrowserSession: () => ({ cookies: EXTRACTED.map((c) => ({ ...c })) }),
      extractBrowserCookies: () => ({ cookies: EXTRACTED.map((c) => ({ ...c })) }),
    }),
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface HandlerRun {
  hung: boolean;
  exitCodes: number[];
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

async function runGo(flags: Record<string, string | boolean>): Promise<HandlerRun> {
  const mod = await import("../src/cli-v7/breath/go.js");
  // Refuse to run a handler that cannot be given fakes. Without the seam the
  // call below would drive a REAL Chrome and read this machine's REAL cookie
  // store — so "no seam" is a red test, never a live browser. It is also the
  // honest verdict: the seam is part of the change under test.
  if (typeof (mod as { REAL_GO_DEPS?: unknown }).REAL_GO_DEPS !== "object") {
    throw new Error(
      "breath/go.ts exports no REAL_GO_DEPS seam — refusing to run the handler against the real browser/cookie store",
    );
  }
  const { handler } = mod;
  const parsed: ParsedV7Args = {
    verb: "breath",
    sub: "go",
    positional: [URL_PRIVATE],
    flags,
    wantsHelp: false,
    wantsJson: true,
  };

  const exitCodes: number[] = [];
  let stdout = "";
  let stderr = "";
  const realExit = process.exit;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);

  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    stdout += c;
    return true;
  };
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    stderr += c;
    return true;
  };

  const started = Date.now();
  const HUNG = Symbol("hung");
  try {
    const outcome = await Promise.race([
      handler(parsed, { json: true }, deps()).then(
        () => "returned" as const,
        (err) => (err instanceof ExitSignal ? ("exited" as const) : Promise.reject(err)),
      ),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 20_000)),
    ]);
    return { hung: outcome === HUNG, exitCodes, stdout, stderr, elapsedMs: Date.now() - started };
  } finally {
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    (process.stdout as unknown as { write: typeof realOut }).write = realOut;
    (process.stderr as unknown as { write: typeof realErr }).write = realErr;
  }
}

function envelope(stream: string, pick: (v: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (pick(v)) return v;
    } catch {
      /* not a JSON line */
    }
  }
  return null;
}

const okEnvelope = (s: string) => envelope(s, (v) => v.ok === true);
const errEnvelope = (s: string) => envelope(s, (v) => typeof v.error === "string");
const setCookiesCall = () => spy.calls.find((c) => c.method === "Network.setCookies");
const navigateCalls = () => spy.calls.filter((c) => c.method === "Page.navigate");
/**
 * Every outbound call the handler attempted. All of them are refused by the
 * stub, so this is an inventory, not a leak — and it must stay empty: the only
 * thing that would populate it is the direct-fetch supplement, which on the
 * re-use path would re-fetch the page under whatever cookie set we assembled.
 */
const pageFetches = () => spy.fetched;

// Restore whatever was installed when WE swapped, not a module-load snapshot:
// bun loads every test file before running any test, so another file's global
// fetch interceptor may be installed between our load and our beforeEach, and
// restoring the load-time value would silently uninstall it for that file's own
// tests.
let priorFetch: typeof globalThis.fetch | undefined;
beforeEach(() => {
  reset();
  delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
  priorFetch = globalThis.fetch;
  // No network, and provably so: EVERY outbound call is recorded and refused.
  (globalThis as unknown as { fetch: unknown }).fetch = (input: unknown) => {
    const u =
      typeof input === "string"
        ? input
        : String((input as { url?: unknown })?.url ?? input);
    spy.fetched.push(u);
    throw new Error("this test must not touch the network");
  };
});
afterEach(() => {
  if (priorFetch) (globalThis as unknown as { fetch: unknown }).fetch = priorFetch;
});
afterAll(() => {
  delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Defect A — `act go --session` keeps the session it was handed", () => {
  it("navigates the session's EXISTING tab instead of building a new context", async () => {
    const run = await runGo({ session: "S-live", timeout: "5000" });

    expect(run.hung).toBe(false);
    expect(run.exitCodes[0]).toBe(0);

    // The defect, stated mechanically: a fresh context was built every time.
    expect(spy.createdTargets).toBe(0);
    expect(spy.spawns).toBe(0);
    expect(spy.attachEndpoints).toEqual([WS]);
    expect(spy.attachedTargets).toEqual([FAKE_SESSION.targetId]);

    // …and the navigation happened on THAT tab's flat session.
    const nav = navigateCalls();
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(nav[0].sessionId).toBe("flat-existing");
    expect(nav[0].params?.url).toBe(URL_PRIVATE);

    const env = okEnvelope(run.stdout);
    // Same session id back — a new uuid here is the silent swap that made the
    // agent think it was still logged in.
    expect(env?.session_id).toBe("S-live");
    expect(env?.target_id).toBe(FAKE_SESSION.targetId);
    expect(env?.session_reused).toBe(true);
    expect(env?.url).toBe(URL_PRIVATE);
    expect(pageFetches()).toEqual([]);

    // The session record still points at the same Chrome and tab.
    expect(spy.written.length).toBe(1);
    expect(spy.written[0].sessionId).toBe("S-live");
    expect(spy.written[0].targetId).toBe(FAKE_SESSION.targetId);
    expect(spy.written[0].chromePid).toBe(PID);
  }, 30_000);

  it("does not write a stale browser-profile copy over the cookie the login just set", async () => {
    const run = await runGo({ session: "S-live", timeout: "5000" });
    expect(run.exitCodes[0]).toBe(0);

    // The jar is read BEFORE it is written to.
    const idxRead = spy.calls.findIndex((c) => c.method === "Network.getCookies");
    const idxWrite = spy.calls.findIndex((c) => c.method === "Network.setCookies");
    expect(idxRead).toBeGreaterThanOrEqual(0);
    expect(idxWrite).toBeGreaterThan(idxRead);

    const injected = (setCookiesCall()?.params?.cookies ?? []) as Array<{ name: string; value: string }>;
    const names = injected.map((c) => c.name).sort();
    // `fixture_session` is live in the tab — the extracted copy is older by
    // construction and must not be written back over it.
    expect(names).toEqual(["fixture_remember"]);
    expect(injected.some((c) => c.value === "STALE-from-browser-profile")).toBe(false);

    const env = okEnvelope(run.stdout);
    expect(env?.cookies_injected).toBe(1);
    expect(env?.cookies_preserved).toBe(2);
    expect(env?.session_reused).toBe(true);
    expect(pageFetches()).toEqual([]);
  }, 30_000);

  it("fails CLOSED when the live jar cannot be read — no blind write", async () => {
    cfg.jarReadable = false;
    const run = await runGo({ session: "S-live", timeout: "5000" });

    expect(run.exitCodes[0]).toBe(0);
    // Writing blind here is the bug itself: it would put the older copy over a
    // login we could not see. Skipping injection loses nothing that was there.
    expect(setCookiesCall()).toBeUndefined();
    const env = okEnvelope(run.stdout);
    expect(env?.cookies_injected).toBe(0);
    expect(env?.cookies_preserved).toBe(0);
  }, 30_000);

  it("refuses a dead session instead of quietly opening a fresh logged-out one", async () => {
    cfg.sessionKnown = false;
    const run = await runGo({ session: "S-gone", timeout: "5000" });

    expect(run.exitCodes[0]).not.toBe(0);
    expect(spy.spawns).toBe(0);
    expect(spy.createdTargets).toBe(0);
    const env = errEnvelope(run.stderr);
    expect(env?.error).toBe("session_expired");
  }, 30_000);

  it("without --session still opens a NEW session (the isolation path is unchanged)", async () => {
    const run = await runGo({ timeout: "5000" });

    expect(run.exitCodes[0]).toBe(0);
    expect(spy.spawns).toBe(1);
    expect(spy.createdTargets).toBe(1);
    expect(spy.createdTargetUrls).toEqual(["about:blank"]);
    expect(spy.attachedTargets).toEqual([]);
    expect(spy.reaps).toBe(1); // the footprint cap still runs when we spawn

    const env = okEnvelope(run.stdout);
    expect(env?.session_reused).toBe(false);
    expect(env?.session_id).not.toBe("S-live");
    expect(env?.target_id).toBe("T-fresh");
    expect(env?.final_url).toBe(URL_PRIVATE);
    const freshNavigate = navigateCalls()[0];
    expect(freshNavigate?.params).toEqual({ url: URL_PRIVATE });
    expect(spy.calls.findIndex((c) => c.method === "Page.enable")).toBeLessThan(
      spy.calls.findIndex((c) => c.method === "Page.navigate"),
    );
    // Fresh context = fresh jar, so every extracted cookie is injected and none
    // is "preserved" (the field is re-use-only).
    expect(env?.cookies_injected).toBe(2);
    expect(env?.cookies_preserved).toBeUndefined();
  }, 30_000);

  it("withoutClobberingLiveCookies keeps live names and passes new ones through", async () => {
    const { withoutClobberingLiveCookies } = await import("../src/cli-v7/breath/go.js");
    expect(withoutClobberingLiveCookies(LIVE_JAR, EXTRACTED).map((c) => c.name)).toEqual([
      "fixture_remember",
    ]);
    // Empty jar = nothing to protect; every candidate goes in.
    expect(withoutClobberingLiveCookies([], EXTRACTED).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Defect B — `--timeout` is read, not just advertised", () => {
  it("bounds the act at the flag's value instead of hanging on a dead target", async () => {
    cfg.hangOn = "Page.navigate";
    const run = await runGo({ session: "S-live", timeout: "250" });

    expect(run.hung).toBe(false);
    expect(run.elapsedMs).toBeLessThan(5_000);
    expect(run.exitCodes[0]).toBe(69); // EX_TARGET_LOST
    const env = errEnvelope(run.stdout);
    expect(env?.error).toBe("target_lost");
    expect(env?.timeout_ms).toBe(250);
    expect(String(env?.waiting_on)).toContain(FAKE_SESSION.targetId);
    expect(env?.session_id).toBe("S-live");
    expect(env?.ok).toBe(false);
  }, 30_000);

  it("the readyState poll scales with --timeout instead of a hardcoded 6s", async () => {
    // No cookie import: keeps the direct-fetch supplement (and the network) out
    // of a measurement that is about a clock.
    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "0";
    // This test measures the readyState poll only; the independent automatic
    // captcha probe has its own deadline tests and must not consume this clock.
    process.env.UNBROWSE_AUTO_SOLVE = "0";
    cfg.readyState = "loading"; // never completes → the poll runs its full budget

    const short = await runGo({ session: "S-live", timeout: "1000" });
    reset();
    cfg.readyState = "loading";
    const long = await runGo({ session: "S-live", timeout: "4000" });

    // Timing first, deliberately: it is the load-bearing claim, and the test
    // above abandons a hung handler on purpose, so a broken build can land a
    // stray exit code here. The clock cannot be contaminated that way.
    //
    // Hardcoded 6000 → BOTH of these fail: each run sits ~6s, and the gap
    // between them collapses to noise.
    expect(long.elapsedMs).toBeLessThan(3_500);
    expect(long.elapsedMs - short.elapsedMs).toBeGreaterThan(700);

    expect(short.exitCodes[0]).toBe(0);
    expect(long.exitCodes[0]).toBe(0);
    // A page that never reaches readyState:complete is still a navigation, not
    // a failure — the bound must not turn best-effort body reading into one.
    expect(okEnvelope(long.stdout)?.ok).toBe(true);
    expect(pageFetches()).toEqual([]);
  }, 40_000);
});
