#!/usr/bin/env bun
/**
 * E2E INSTALL MATRIX — the permutation matrix, projected onto a real install.
 *
 * `tests/algorithm-permutations.test.ts` walks 7,938 cells of the decision layer
 * because those functions are PURE. A shipped binary is not pure — it has an
 * install step, a filesystem, a network, and a browser — so this file does NOT
 * pretend to re-run that matrix end to end. It runs the subset of the same
 * invariants that are OBSERVABLE FROM OUTSIDE the binary, against a genuinely
 * installed `unbrowse`, and says plainly which ones it cannot see.
 *
 * The distinction matters because the two files fail differently:
 *   - the pure matrix catches a decision that is wrong in principle;
 *   - this catches a decision that is right in principle and never reaches the
 *     user — wrong wiring, a broken package, a binary that resolves to the
 *     developer's source tree instead of the installed one.
 *
 * THE RULE THAT OUTRANKS EVERYTHING (bench doctrine): never convert an
 * unavailable check into a PASS. Transport success is not task success — exit 0,
 * HTTP 200 and `ok:true` each prove only that something moved. A cell whose
 * precondition is missing is reported UNSTAMPED with the blocker named, and
 * UNSTAMPED is not green.
 *
 *   bun tests/e2e/install-matrix.ts                # pack, install, run everything
 *   bun tests/e2e/install-matrix.ts --no-install   # reuse an existing UNBROWSE_BIN
 *   bun tests/e2e/install-matrix.ts --offline      # skip network cells (as UNSTAMPED)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const ARGS = new Set(process.argv.slice(2));
const NO_INSTALL = ARGS.has("--no-install");
const OFFLINE = ARGS.has("--offline");

type Status = "PASS" | "FAIL" | "UNSTAMPED";
interface Cell {
  id: string;
  invariant: string;
  /** Which pure-matrix invariant this projects, so the two files stay linked. */
  projects?: string;
  needsNetwork?: boolean;
  run: (ctx: Ctx) => Promise<{ status: Status; detail: string }>;
}
interface Ctx {
  bin: string;
  home: string;
  sh: (argv: string[], opts?: ShellOpts) => Shell;
  json: (argv: string[], opts?: ShellOpts) => unknown;
}
interface ShellOpts { env?: Record<string, string>; timeoutMs?: number; input?: string }
interface Shell { code: number | null; stdout: string; stderr: string; ms: number }

const results: Array<{ id: string; invariant: string; projects?: string; status: Status; detail: string; ms: number }> = [];

function shell(bin: string, home: string) {
  return (argv: string[], opts: ShellOpts = {}): Shell => {
    const t0 = Date.now();
    const r = spawnSync(bin, argv, {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 180_000,
      ...(opts.input === undefined ? {} : { input: opts.input }),
      env: {
        ...process.env,
        UNBROWSE_HOME: home,
        UNBROWSE_LOCAL_ONLY: "1",
        // Grade the BINARY, not a replayed envelope. The CLI resolve cache (10 min
        // by default) serves verdicts produced by builds that no longer exist —
        // measured: a cached false-success outlived the fix that removed it, and
        // made this harness report a bug that had already been fixed.
        UNBROWSE_RESOLVE_CACHE_TTL_MS: "0",
        ...(opts.env ?? {}),
      },
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: Date.now() - t0 };
  };
}

/** Pull the last JSON object out of stdout — the CLI prefixes human log lines. */
function lastJson(stdout: string): unknown {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep walking back */ }
  }
  return null;
}

/** Is anything listening on this loopback port right now? */
function listenerOn(port: number): boolean {
  const r = spawnSync("bash", ["-c", `cat < /dev/null > /dev/tcp/127.0.0.1/${port}`], { timeout: 4000 });
  return r.status === 0;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/**
 * Read `browser_opened` from wherever this result shape actually carries it.
 *
 * The orchestrator's own field is `timing.browser_opened`; ONE exit path copies
 * it to the top level (`src/orchestrator/index.ts` — `browser_opened:
 * output.timing.browser_opened === true`). Cells that read only the top level
 * were therefore reading `undefined` on every shape that does not hoist —
 * measured against a real `deferral` response, whose keys are
 * decision_trace/impact/intent_verdict/result/run_plan/source/timing/trace and
 * include no top-level `browser_opened` at all. "Never opened a browser" and
 * "the field is missing" are not the same claim, and three cells could not tell
 * them apart.
 */
const browserOpened = (out: Record<string, unknown>): boolean | undefined => {
  if (typeof out.browser_opened === "boolean") return out.browser_opened;
  const nested = rec(out.timing).browser_opened;
  if (typeof nested === "boolean") return nested;
  // Neither field exists on the browse/capture shape — and that shape is the one
  // that ACTUALLY drives a browser. Measured against example.com: Chrome parent
  // processes went 19 -> 21, `capture.ms` was 12474 for `endpoints_discovered:
  // 0` (the barren page this suite cares about), and `timing` was the single key
  // `{"cache_hit": false}`. Asking for a boolean that the payload never sets
  // would report "no browser" for a call that just spent 12 seconds in one.
  //
  // So recognise the browser by its SHAPE, per the repo's standing rule: a live
  // browse session with a tab or a devtools endpoint means a browser was driven,
  // whether it was freshly launched or attached to.
  const browse = rec(out.browse);
  const tab = browse.tab_id, session = browse.session_id;
  const debugUrl = rec(browse.autonomy).chrome_debug_url;
  if ((typeof tab === "string" && tab) || (typeof session === "string" && session) || (typeof debugUrl === "string" && debugUrl)) {
    return true;
  }
  return undefined;
};

/**
 * Likewise for the decision trace: it is a TOP-LEVEL array on the shipped
 * result, not `trace.decision_trace`. Reading the nested path returned [] every
 * time, which is why the never-twice guard reported "not exercised" no matter
 * what the binary did.
 */
const decisionTrace = (out: Record<string, unknown>): Array<Record<string, unknown>> => {
  const top = out.decision_trace;
  if (Array.isArray(top)) return top as Array<Record<string, unknown>>;
  const nested = rec(out.trace).decision_trace;
  return Array.isArray(nested) ? nested as Array<Record<string, unknown>> : [];
};

// ─────────────────────────────────────────────────────────────────────────────
// The cells
// ─────────────────────────────────────────────────────────────────────────────

const CELLS: Cell[] = [
  {
    id: "E1-binary-exists",
    invariant: "the installed package puts an `unbrowse` binary where a user can run it",
    run: async (ctx) => {
      if (!existsSync(ctx.bin)) return { status: "FAIL", detail: `no binary at ${ctx.bin}` };
      return { status: "PASS", detail: ctx.bin };
    },
  },
  {
    id: "E2-reports-identity",
    invariant: "the installed binary reports a version and a build sha — never an anonymous binary",
    run: async (ctx) => {
      const out = rec(ctx.json(["health", "--json"]));
      const version = out.version, sha = out.buildSha;
      if (typeof version !== "string" || !version) return { status: "FAIL", detail: "no version in health --json" };
      if (typeof sha !== "string" || !sha) return { status: "FAIL", detail: "no buildSha — cannot tell WHICH build was graded" };
      return { status: "PASS", detail: `version=${version} sha=${sha}` };
    },
  },
  {
    id: "E3-graded-binary-is-installed-one",
    invariant: "the harness grades the INSTALLED package, not the developer's source tree",
    run: async (ctx) => {
      // The single most common way an install test lies to itself.
      if (ctx.bin.startsWith(REPO) && !ctx.bin.includes("node_modules")) {
        return { status: "FAIL", detail: `binary resolves inside the repo (${ctx.bin}) — that is source, not an install` };
      }
      // A path outside the repo is NOT sufficient: a global shim can symlink
      // straight back into the workspace. The build sha is the honest tell —
      // `-dirty` means it was built from an uncommitted tree, i.e. source.
      const sha = String(rec(ctx.json(["health", "--json"])).buildSha ?? "");
      if (sha.endsWith("-dirty")) {
        return { status: "FAIL", detail: `buildSha=${sha} — a dirty local build, so this is the workspace wearing an install's path (${ctx.bin})` };
      }
      return { status: "PASS", detail: `install outside the source tree, buildSha=${sha}` };
    },
  },
  {
    id: "E4-no-auto-daemon",
    invariant: "a CLI call does NOT auto-spawn a local daemon (CLAUDE.md: local runtime authority)",
    run: async (ctx) => {
      // Reading a preflight field proves nothing about daemons — the original
      // version of this cell asserted its own name rather than the invariant.
      // The real question is whether a CLI call leaves a listener behind.
      const portBefore = listenerOn(6969);
      const out = rec(ctx.json(["health", "--json"]));
      if (Object.keys(out).length === 0) return { status: "UNSTAMPED", detail: "health --json emitted nothing to judge" };
      const portAfter = listenerOn(6969);
      if (!portBefore && portAfter) {
        return { status: "FAIL", detail: "a CLI call spawned a listener on 6969 — the stateless runtime auto-started a daemon" };
      }
      if (portBefore) return { status: "UNSTAMPED", detail: "something was already listening on 6969 before the call; cannot attribute" };
      return { status: "PASS", detail: "no daemon listener appeared after a CLI call" };
    },
  },
  {
    id: "E6-unbrowse-home-really-isolates",
    invariant: "UNBROWSE_HOME relocates ALL on-disk state — an isolated run never writes the caller's real ~/.unbrowse",
    // Found by this harness auditing itself. `runtime/paths.ts` documents
    // UNBROWSE_HOME as relocating the data root "everywhere (U-3)", but the
    // orchestrator's caches were built from process.env.HOME directly, so a run
    // with UNBROWSE_HOME set put logs/ and config.json in the temp home and
    // still wrote route-cache.json into the developer's real one. That silently
    // voids every isolation claim built on this knob — including
    // `bench/retry`'s "each site gets a fresh UNBROWSE_HOME, so try 1 is
    // genuinely cold", whose cold call was reading a warm cache.
    needsNetwork: true,
    run: async (ctx) => {
      const realHome = join(homedir(), ".unbrowse");
      const watched = ["route-cache.json", "domain-skill-cache.json", "barren-pages.json"];
      const stamp = (): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const f of watched) {
          const p = join(realHome, f);
          out[f] = existsSync(p) ? statSync(p).mtimeMs : 0;
        }
        return out;
      };
      if (!existsSync(realHome)) return { status: "UNSTAMPED", detail: `no ${realHome} on this machine; nothing to protect` };

      // Another unbrowse (an agent host's long-lived `unbrowse mcp`, say) writes
      // the same real home on its own schedule, and its writes are
      // indistinguishable from ours by mtime alone. Same rule as E4: a result we
      // cannot attribute is UNSTAMPED, never a FAIL pinned on the binary here.
      // Match only processes that could actually WRITE the data root: an
      // unbrowse node runtime. A bare "unbrowse" substring also catches every
      // Chrome renderer launched out of ~/.cache/unbrowse/chrome — measured at
      // 97 of 117 matches — and a renderer cannot write route-cache.json.
      // Counting those made the cell block itself on almost every machine,
      // which is its own way of never measuring anything.
      const others = spawnSync("pgrep", ["-af", "unbrowse"], { encoding: "utf8", timeout: 10_000 });
      const foreign = (others.stdout ?? "").split("\n").filter((l) => {
        if (!l.trim() || l.includes(ctx.bin) || l.includes("install-matrix")) return false;
        if (/chrome|crashpad/i.test(l)) return false;
        return /runtime\/(cli|mcp)\.js|bin\/unbrowse|unbrowse\.js/.test(l);
      });
      if (foreign.length) {
        return { status: "UNSTAMPED", detail: `${foreign.length} other unbrowse runtime(s) can write ${realHome} concurrently; cannot attribute a change to the binary under test` };
      }

      const before = stamp();
      ctx.sh(["list the quotes", "--url", "https://quotes.toscrape.com/", "--json"], { timeoutMs: 180_000 });
      const after = stamp();

      const leaked = watched.filter((f) => after[f] !== before[f]);
      if (leaked.length) {
        return { status: "FAIL", detail: `a run with UNBROWSE_HOME=${ctx.home} wrote the caller's real ${realHome}: ${leaked.join(", ")} — isolation is not real` };
      }
      return { status: "PASS", detail: `real ${realHome} untouched (${watched.length} caches watched)` };
    },
  },
  {
    id: "E5-mcp-surface-speaks-protocol",
    invariant: "the MCP surface an agent actually consumes handshakes and names its tools",
    // Added because the harness graded only the CLI while the real consumer of
    // this binary — the agent in `[mcp_servers.unbrowse]` — never calls the CLI
    // at all. A binary whose CLI is perfect and whose MCP surface cannot
    // handshake is broken for every one of its actual users, and no cell here
    // could see it.
    run: async (ctx) => {
      const wire = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "install-matrix", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ].map((m) => JSON.stringify(m)).join("\n") + "\n";

      const r = ctx.sh(["mcp"], { input: wire, timeoutMs: 90_000, env: { UNBROWSE_MCP_SURFACE: "agent", UNBROWSE_NON_INTERACTIVE: "1" } });
      const frames: Array<Record<string, unknown>> = [];
      for (const line of r.stdout.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try { frames.push(JSON.parse(s) as Record<string, unknown>); } catch { /* not a frame */ }
      }
      if (frames.length === 0) {
        return { status: "UNSTAMPED", detail: `MCP emitted no JSON-RPC frame (exit=${r.code}); cannot judge the surface` };
      }
      const init = frames.find((f) => f.id === 1);
      if (init && rec(init.error).code !== undefined) {
        return { status: "FAIL", detail: `initialize returned an error: ${JSON.stringify(init.error).slice(0, 200)}` };
      }
      const list = frames.find((f) => f.id === 2);
      if (!list) return { status: "UNSTAMPED", detail: `no response to tools/list among ${frames.length} frame(s); cannot judge` };
      if (rec(list.error).code !== undefined) {
        return { status: "FAIL", detail: `tools/list returned an error: ${JSON.stringify(list.error).slice(0, 200)}` };
      }
      const tools = rec(list.result).tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        return { status: "FAIL", detail: "MCP surface advertises no tools — an agent connecting to it can do nothing" };
      }
      const unnamed = tools.filter((t) => !String(rec(t).name ?? "").trim());
      if (unnamed.length) return { status: "FAIL", detail: `${unnamed.length} advertised tool(s) have no name` };
      return { status: "PASS", detail: `${tools.length} tools, e.g. ${tools.slice(0, 3).map((t) => String(rec(t).name)).join(", ")}` };
    },
  },
  {
    id: "M-I8-failures-name-a-reason",
    invariant: "a failed verdict always names an error — a silent failure is undebuggable",
    projects: "I8 (every decision carries a non-empty reason)",
    run: async (ctx) => {
      // A domain that cannot resolve: the failure must be legible, not blank.
      const r = ctx.sh(["get the items", "--url", "https://unresolvable.invalid/x", "--json"], { timeoutMs: 120_000 });
      const out = rec(lastJson(r.stdout));
      if (Object.keys(out).length === 0) return { status: "UNSTAMPED", detail: "no JSON emitted to judge" };
      const trace = rec(out.trace);
      const named = out.error ?? trace.error ?? out.status;
      if (out.ok === true || trace.success === true) {
        return { status: "FAIL", detail: "claimed success against an unresolvable host — transport success laundered as task success" };
      }
      if (!named) return { status: "FAIL", detail: "failed with no named error" };
      return { status: "PASS", detail: `named=${String(named)}` };
    },
  },
  {
    id: "M-I5-auth-wall-opens-no-browser",
    invariant: "an auth wall never spends a browser launch — a browser cannot supply a session we lack",
    projects: "I5 (never escalate on an auth wall)",
    needsNetwork: true,
    run: async (ctx) => {
      const r = ctx.sh(["read my private inbox", "--url", "https://github.com/settings/profile", "--json"], { timeoutMs: 180_000 });
      const out = rec(lastJson(r.stdout));
      if (Object.keys(out).length === 0) return { status: "UNSTAMPED", detail: "no JSON emitted to judge" };
      const result = rec(out.result);
      const authShaped = result.blocker === "auth" || result.auth_required === true || result.auth_ok === false
        || String(out.error ?? rec(out.trace).error ?? "").includes("auth");
      if (!authShaped) return { status: "UNSTAMPED", detail: "target did not present as auth-blocked; nothing to assert" };
      if (browserOpened(out) === true) {
        return { status: "FAIL", detail: "opened a browser for an auth wall it cannot climb" };
      }
      return { status: "PASS", detail: "auth-blocked and browser_opened !== true" };
    },
  },
  {
    id: "M-I3-never-two-browser-opens",
    invariant: "one call never reports more than one browser open (the floor is not a ladder)",
    projects: "I3 (escalate only when no browser opened already)",
    needsNetwork: true,
    run: async (ctx) => {
      const r = ctx.sh(["list the quotes", "--url", "https://quotes.toscrape.com/", "--json"], { timeoutMs: 180_000 });
      const out = rec(lastJson(r.stdout));
      if (Object.keys(out).length === 0) return { status: "UNSTAMPED", detail: "no JSON emitted to judge" };
      const arr = decisionTrace(out);
      const opens = arr.filter((s) => String(s.step ?? "").startsWith("browser_fallback_")).length;
      // `opens > 1` alone was unfalsifiable: the orchestrator returns immediately
      // after recording a fallback step, so a second one cannot occur no matter
      // how broken the guard is. The falsifiable half is the CONTRADICTION —
      // a rescue step recorded while the verdict denies a browser ever opened.
      const rescued = arr.some((s) => String(s.step ?? "") === "browser_fallback_rescued");
      if (opens > 1) return { status: "FAIL", detail: `${opens} browser-fallback steps in one call` };
      if (rescued && browserOpened(out) !== true) {
        return { status: "FAIL", detail: "reports a browser rescue while browser_opened is not true — contradictory terminal fields" };
      }
      // Measured: against a target that resolves without ever needing a rescue,
      // both checks above are unreachable and this cell stamped PASS having
      // asserted NOTHING about the never-twice guard. That is an unavailable
      // check laundered into green — the one thing this suite forbids. If no
      // fallback occurred, the invariant was not exercised; say so.
      if (opens === 0) {
        return { status: "UNSTAMPED", detail: `no browser-fallback step occurred against this target, so the never-twice guard was not exercised (browser_opened=${String(browserOpened(out))})` };
      }
      return { status: "PASS", detail: `steps=${opens} rescued=${rescued} browser_opened=${String(browserOpened(out))}` };
    },
  },
  {
    id: "M-I7-barren-page-not-repaid",
    invariant: "a page a browser already found nothing on is not re-paid for on the next call",
    projects: "I7 (never escalate on a barren page)",
    needsNetwork: true,
    run: async (ctx) => {
      const argv = ["get the api data", "--url", "https://example.com/", "--json"];
      const cold = ctx.sh(argv, { timeoutMs: 180_000 });
      const warm = ctx.sh(argv, { timeoutMs: 180_000 });
      const w = rec(lastJson(warm.stdout));
      if (Object.keys(w).length === 0) return { status: "UNSTAMPED", detail: "no JSON emitted on the warm call" };
      const c = rec(lastJson(cold.stdout));
      // Each ctx.sh() is a SEPARATE PROCESS. This cell only means anything because
      // the barren set is now persisted to disk — with the original in-memory-only
      // Map it could never hold, and the cell would have been quietly vacuous.
      if (browserOpened(c) !== true) {
        return { status: "UNSTAMPED", detail: "cold call opened no browser, so there is no barren memory to test" };
      }
      if (browserOpened(w) === true) {
        return { status: "FAIL", detail: `warm call re-opened a browser across processes (cold=${cold.ms}ms warm=${warm.ms}ms) — barren memory did not persist` };
      }
      return { status: "PASS", detail: `cold=${cold.ms}ms opened a browser; warm=${warm.ms}ms did not` };
    },
  },
  {
    id: "M-P1-private-mode-publishes-nothing",
    invariant: "with sharing off, nothing is eligible to publish — the opt-out is real",
    projects: "P1 (share_pointers=false never yields public visibility)",
    run: async (ctx) => {
      const set = ctx.sh(["config", "set", "telemetry", "false", "--json"], { timeoutMs: 60_000 });
      if (set.code !== 0) return { status: "UNSTAMPED", detail: `could not set private mode: exit ${set.code}` };
      const out = rec(lastJson(set.stdout));
      if (out.share_pointers !== false) return { status: "FAIL", detail: `share_pointers is ${String(out.share_pointers)} after opting out` };
      if (out.auto_publish_checkpoints !== false) {
        return { status: "FAIL", detail: "checkpoint auto-publish still on after opting out — the opt-out is partial" };
      }
      return { status: "PASS", detail: "share_pointers=false and auto_publish_checkpoints=false" };
    },
  },
  {
    id: "M-R1-warm-call-replays",
    invariant: "a learned route is replayed on the next identical call rather than re-derived",
    projects: "R1 (what the writer stores, the reader accepts)",
    needsNetwork: true,
    run: async (ctx) => {
      const argv = ["list the quotes", "--url", "https://quotes.toscrape.com/", "--json"];
      const cold = ctx.sh(argv, { timeoutMs: 180_000 });
      const warm = ctx.sh(argv, { timeoutMs: 180_000 });
      const c = rec(lastJson(cold.stdout)), w = rec(lastJson(warm.stdout));
      if (Object.keys(c).length === 0 || Object.keys(w).length === 0) {
        return { status: "UNSTAMPED", detail: "no JSON on one of the calls" };
      }
      // Capability may only hold or improve warm — never regress.
      const capOf = (o: Record<string, unknown>) => (o.ok === true || rec(o.trace).success === true) ? 1 : 0;
      if (capOf(w) < capOf(c)) return { status: "FAIL", detail: "warm call LOST capability the cold call had" };
      return { status: "PASS", detail: `cold=${cold.ms}ms warm=${warm.ms}ms, capability held` };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Install
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `packages/skill`'s `prepack` refuses to build an unsigned release, so a local
 * pack needs the HMAC signing key. `scripts/cloud-agent-latest-unbrowse-witness.sh`
 * already reads it from `~/.unbrowse/release.env`; this uses the same sanctioned
 * path rather than inventing a second one, and never logs the value — only
 * whether a key was found. A locally-signed manifest is not a publishable
 * release: it verifies against this machine's key alone, which is exactly what a
 * throwaway test install should produce.
 */
function releaseSigningEnv(): { ok: boolean; env: Record<string, string>; note: string } {
  const key = "UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET";
  // `ok` is reported explicitly rather than inferred from `env` being non-empty:
  // the inherited case legitimately contributes NO new variables (it is already
  // in process.env, which the spawn spreads), so an emptiness test read that as
  // "no key" and threw while its own note said the key was present — two
  // contradictory terminal fields in one payload, the exact fault this suite
  // exists to catch.
  if ((process.env[key] ?? "").trim()) {
    return { ok: true, env: {}, note: "signing key: inherited from the environment" };
  }
  const envFile = join(homedir(), ".unbrowse", "release.env");
  if (!existsSync(envFile)) return { ok: false, env: {}, note: `signing key: absent (${envFile} not found)` };
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.trim().startsWith(`export ${key}=`));
  if (!line) return { ok: false, env: {}, note: `signing key: ${envFile} has no ${key}` };
  let value = line.slice(line.indexOf("=") + 1).trim();
  if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
  if (!value) return { ok: false, env: {}, note: `signing key: ${key} present but empty` };
  return { ok: true, env: { [key]: value }, note: `signing key: loaded from ${envFile}` };
}

/** Tracked files git currently reports as modified. */
function modifiedTracked(): Set<string> {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: REPO, encoding: "utf8", timeout: 30_000,
  });
  const out = new Set<string>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const path = line.slice(3).trim();
    if (path) out.add(path);
  }
  return out;
}

/**
 * Undo tree mutations that `prepack` made as a side effect.
 *
 * `scripts/build-release-manifest.ts` rewrites `src/build-info.generated.ts`,
 * which is TRACKED. Leaving that behind is worse than untidy: `buildSha` is
 * `RUNTIME_GIT_SHA`, resolved live from `git status --porcelain`, so a tree this
 * harness dirtied makes every later local call self-report `-dirty` — the exact
 * condition E3 fails on. Un-restored, the harness manufactures the failure it
 * then reports, and the second run of a green suite goes red for no other reason.
 *
 * Only files that were CLEAN before the pack are restored, so a developer's own
 * uncommitted work is never discarded.
 */
function restoreTree(before: Set<string>): string[] {
  const collateral = [...modifiedTracked()].filter((p) => !before.has(p));
  if (collateral.length) {
    spawnSync("git", ["checkout", "--", ...collateral], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
  }
  return collateral;
}

function installUnbrowse(): { bin: string; note: string } {
  const stage = mkdtempSync(join(tmpdir(), "unbrowse-e2e-"));
  const prefix = join(stage, "prefix");
  mkdirSync(prefix, { recursive: true });

  const signing = releaseSigningEnv();
  console.log(`[install] ${signing.note}`);
  if (!signing.ok) {
    throw new Error(
      `cannot pack a release without a signing key — ${signing.note}. ` +
      `packages/skill prepack refuses to build unsigned; set UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET or provide ~/.unbrowse/release.env`,
    );
  }

  // Disclosed, not silent: `prepack` runs `build:runtime`, which rebuilds
  // `packages/skill/runtime/` IN PLACE. That directory is gitignored, so the
  // tracked-file restore below cannot put it back — and on a machine where a
  // global install symlinks to `packages/skill` (the usual dev setup:
  // `~/.local/lib/node_modules/unbrowse -> packages/skill`), packing here
  // silently replaces the user's installed runtime, under any long-running
  // process already serving from it. Equivalent code, but a real mutation of
  // something outside this test, so it is announced rather than hidden.
  const globalLink = join(homedir(), ".local", "lib", "node_modules", "unbrowse");
  if (existsSync(globalLink)) {
    console.log(`[install] NOTE: prepack rebuilds packages/skill/runtime/ in place; ${globalLink} resolves into this tree and will pick up that rebuild`);
  }

  const dirtyBefore = modifiedTracked();
  console.log(`[install] packing packages/skill …`);
  const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", stage], {
    cwd: join(REPO, "packages", "skill"), encoding: "utf8", timeout: 900_000,
    env: { ...process.env, ...signing.env },
  });
  const restored = restoreTree(dirtyBefore);
  if (restored.length) console.log(`[install] restored ${restored.length} file(s) prepack rewrote: ${restored.join(", ")}`);
  if (pack.status !== 0) throw new Error(`npm pack failed (${pack.status}): ${pack.stderr?.slice(0, 800)}`);
  const tarball = readdirSync(stage).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");

  console.log(`[install] installing ${tarball} into an isolated prefix …`);
  const inst = spawnSync("npm", ["install", "--silent", "--prefix", prefix, "--no-audit", "--no-fund", join(stage, tarball)], {
    encoding: "utf8", timeout: 900_000,
  });
  if (inst.status !== 0) throw new Error(`npm install failed (${inst.status}): ${inst.stderr?.slice(0, 800)}`);

  const bin = join(prefix, "node_modules", ".bin", "unbrowse");
  return { bin, note: `packed+installed from source into ${prefix}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "unbrowse-e2e-home-"));
let bin = process.env.UNBROWSE_BIN ?? "";
let installNote = `reused UNBROWSE_BIN=${bin}`;

/**
 * A blocked install is an unanswered question, not a crash.
 *
 * This used to let `installUnbrowse()` throw straight out of the module, so a
 * missing signing key produced a Bun stack trace, no cell list, and no evidence
 * file — the run said nothing about which invariants were in question. The
 * doctrine already had the right answer for "the precondition is missing":
 * UNSTAMPED with the blocker named. Reuse it rather than dying.
 */
let installBlocker: string | null = null;

if (!NO_INSTALL) {
  try {
    const r = installUnbrowse();
    bin = r.bin; installNote = r.note;
  } catch (err) {
    installBlocker = err instanceof Error ? err.message : String(err);
    installNote = `INSTALL FAILED — ${installBlocker}`;
  }
} else if (!bin) {
  console.error("--no-install requires UNBROWSE_BIN to point at an installed binary");
  process.exit(2);
}

console.log(`\n=== E2E INSTALL MATRIX ===\nbinary : ${bin}\nhome   : ${home}\ninstall: ${installNote}\noffline: ${OFFLINE}\n`);

const ctx: Ctx = {
  bin, home,
  sh: shell(bin, home),
  json: (argv, opts) => lastJson(shell(bin, home)(argv, opts).stdout),
};

for (const cell of CELLS) {
  if (installBlocker) {
    results.push({ id: cell.id, invariant: cell.invariant, projects: cell.projects, status: "UNSTAMPED", detail: `no installed binary to judge: ${installBlocker}`, ms: 0 });
    continue;
  }
  if (cell.needsNetwork && OFFLINE) {
    results.push({ id: cell.id, invariant: cell.invariant, projects: cell.projects, status: "UNSTAMPED", detail: "--offline: network cell not run", ms: 0 });
    continue;
  }
  const t0 = Date.now();
  let out: { status: Status; detail: string };
  try {
    out = await cell.run(ctx);
  } catch (err) {
    out = { status: "UNSTAMPED", detail: `harness error: ${err instanceof Error ? err.message : String(err)}` };
  }
  results.push({ ...out, id: cell.id, invariant: cell.invariant, projects: cell.projects, ms: Date.now() - t0 });
  const icon = out.status === "PASS" ? "ok  " : out.status === "FAIL" ? "FAIL" : "----";
  console.log(`[${icon}] ${cell.id.padEnd(34)} ${out.detail}`);
}

const evidence = join(home, "install-matrix.jsonl");
writeFileSync(evidence, results.map((r) => JSON.stringify(r)).join("\n") + "\n");

const failed = results.filter((r) => r.status === "FAIL");
const unstamped = results.filter((r) => r.status === "UNSTAMPED");
const passed = results.filter((r) => r.status === "PASS");

console.log(`\n${passed.length} PASS · ${failed.length} FAIL · ${unstamped.length} UNSTAMPED`);
console.log(`evidence: ${evidence}`);
if (unstamped.length) {
  console.log(`\nUNSTAMPED is NOT a pass — each names its blocker:`);
  for (const u of unstamped) console.log(`  ${u.id}: ${u.detail}`);
}
if (failed.length) {
  console.log(`\nFAILED INVARIANTS:`);
  for (const f of failed) console.log(`  ${f.id} — ${f.invariant}\n    ${f.detail}`);
}

// Green requires every cell to have actually run and passed. An UNSTAMPED cell
// is an unanswered question, and an unanswered question is not a green gate.
process.exit(failed.length > 0 || unstamped.length > 0 ? 1 : 0);
