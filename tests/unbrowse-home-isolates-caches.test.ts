/**
 * GATE: UNBROWSE_HOME relocates the orchestrator's caches, not just its logs.
 *
 * `src/runtime/paths.ts` documents `getUnbrowseHome()` as the one knob that
 * moves the data root "everywhere (U-3)", and a great deal is built on that
 * promise — test isolation, CI runners, second profiles, and `bench/retry`,
 * which states outright that "each site gets a fresh UNBROWSE_HOME, so try 1 is
 * genuinely cold".
 *
 * The promise was false for exactly the caches that decide cold-vs-warm. The
 * orchestrator built them from `process.env.HOME` directly, so a run with
 * UNBROWSE_HOME set to a temp dir wrote `logs/`, `secrets/` and `config.json`
 * there — and `route-cache.json`, `domain-skill-cache.json` and
 * `barren-pages.json` into the caller's REAL `~/.unbrowse`.
 *
 * Observed, both witnesses, on a run of `tests/e2e/install-matrix.ts`:
 *   - the three caches in the real ~/.unbrowse had fresh mtimes, and
 *   - the isolated UNBROWSE_HOME contained none of them.
 * A "cold" call was therefore free to be served by the developer's warm route
 * cache, which is the one thing a cold/warm benchmark may never do.
 *
 * The E2E projection of this lives in `install-matrix.ts` as
 * `E6-unbrowse-home-really-isolates`, but that cell must report UNSTAMPED
 * whenever another unbrowse process could touch the same real home — which on
 * any machine running an agent host's long-lived `unbrowse mcp` is always. This
 * file is the deterministic witness that does not depend on the machine being
 * quiet.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { readdirSync } from "node:fs";
import { getCaptureSpoolDir } from "../src/lib/indexer-core/capture-spool.js";
import { codeLinesOnly } from "./_source-scan.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getUnbrowseHome } from "../src/runtime/paths.js";

const ORCHESTRATOR = join(import.meta.dirname, "..", "src", "orchestrator", "index.ts");

describe("getUnbrowseHome — the U-3 contract itself", () => {
  const original = process.env.UNBROWSE_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.UNBROWSE_HOME;
    else process.env.UNBROWSE_HOME = original;
  });

  test("an override relocates the data root", () => {
    process.env.UNBROWSE_HOME = "/tmp/isolated-root";
    expect(getUnbrowseHome()).toBe("/tmp/isolated-root");
  });

  test("no override falls back to ~/.unbrowse — the default install is untouched", () => {
    delete process.env.UNBROWSE_HOME;
    expect(getUnbrowseHome()).toBe(join(homedir(), ".unbrowse"));
  });

  test("an empty or whitespace override is ignored, never treated as a real path", () => {
    // Otherwise `UNBROWSE_HOME=` in a shell profile silently relocates every
    // cache to "" and the install appears to lose all its state.
    for (const blank of ["", "   ", "\t"]) {
      process.env.UNBROWSE_HOME = blank;
      expect(getUnbrowseHome(), JSON.stringify(blank)).toBe(join(homedir(), ".unbrowse"));
    }
  });
});

describe("the orchestrator's on-disk caches route through it", () => {
  const src = readFileSync(ORCHESTRATOR, "utf8");

  // Structural pin, following the repo's precedent for wiring that a unit test
  // cannot reach (these are module-level constants, frozen at import). It fails
  // loudly if a future edit reintroduces the raw-HOME form.
  const CACHES = [
    "ROUTE_CACHE_FILE",
    "DOMAIN_CACHE_FILE",
    "BARREN_CACHE_FILE",
    "SKILL_SNAPSHOT_DIR",
  ];

  for (const name of CACHES) {
    test(`${name} derives from getUnbrowseHome()`, () => {
      const idx = src.indexOf(`const ${name} =`);
      expect(idx, `${name} declaration not found`).toBeGreaterThan(0);
      const decl = src.slice(idx, src.indexOf(";", idx));
      expect(decl).toContain("getUnbrowseHome()");
    });

    test(`${name} does NOT read process.env.HOME directly`, () => {
      // Guards the specific wrong form, not merely the absence of the right one:
      // a declaration could contain both and still leak.
      const idx = src.indexOf(`const ${name} =`);
      const decl = src.slice(idx, src.indexOf(";", idx));
      expect(decl).not.toContain("process.env.HOME");
    });
  }

  test("the module actually imports the canonical resolver", () => {
    expect(src).toContain('import { getUnbrowseHome } from "../runtime/paths.js"');
  });
});

const REPO = join(import.meta.dirname, "..");

describe("no module derives an unbrowse path from $HOME any more", () => {
  test("the whole of src/ resolves the data root through one helper", () => {
    // The orchestrator's five paths were fixed first; eight more were still
    // computing `join(process.env.HOME, ".unbrowse", ...)` afterwards, so
    // UNBROWSE_HOME half-isolated a run: telemetry traces, the pending/capture
    // queues and the heartbeat, indexer-core's skill snapshots (the SAME
    // logical directory the orchestrator already resolved through
    // getUnbrowseHome — two halves of one mechanism disagreeing), the capture
    // spool, yield sessions and the SDK wallet.
    //
    // A scan, not a list of files: a NEW module with the same shape is caught
    // the day it lands, which an enumerated inventory would not do.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".ts")) continue;
        const lines = codeLinesOnly(readFileSync(p, "utf8")).split("\n");
        lines.forEach((line, i) => {
          // BOTH spellings. The first version of this scan matched only
          // process.env.HOME, and on that evidence I claimed "U-3 is closed
          // across src/". It was not: 34 files reach the same directory via
          // os.homedir(), including keychain, sealed-blob-store, failure-cache,
          // traces and config.json. A scan that sees one spelling of a thing is
          // not a guard, it is a blind spot with a green tick.
          if (!line.includes(".unbrowse")) return;
          if (!/process\.env\.HOME/.test(line) && !/homedir\(\)/.test(line)) return;
          offenders.push(`${p.slice(REPO.length + 1)}:${i + 1}`);
        });
      }
    };
    walk(join(REPO, "src"));
    // Third-party homes (~/.lobster, ~/.privy, ~/.ows) are deliberately NOT
    // matched: those really are files in the user's home, and relocating them
    // with UNBROWSE_HOME would be wrong.
    //
    // PINNED BACKLOG, not a pass. These files still resolve the data root
    // themselves instead of through getUnbrowseHome(), so UNBROWSE_HOME does
    // NOT fully isolate them. The list may SHRINK, never grow — that is what
    // makes it a migration rather than a permanent exception. src/runtime/paths.ts
    // is excluded because it IS the canonical definition.
    const KNOWN_NOT_YET_MIGRATED = new Set<string>([
    "src/api/routes.ts",
    "src/auth/attest.ts",
    "src/auth/stale-endpoints.ts",
    "src/cli-v7/breath/proxy-rotate.ts",
    "src/cli-v7/eval/screenshot.ts",
    "src/cli-v7/eval/spec.ts",
    "src/cli-v7/eval/trace.ts",
    "src/client/index.ts",
    "src/config/contribution.ts",
    "src/config/payment-provider.ts",
    "src/execution/index.ts",
    "src/execution/proxy-fetch.ts",
    "src/extraction/domain-notes.ts",
    "src/lib/graph-core/trace-store.ts",
    "src/lib/ranking-core/signals/ledger-energy.ts",
    "src/mcp.ts",
    "src/obscura/session-broker.ts",
    "src/single-binary.ts",
    "src/skillmd.ts",
    "src/values/failure-cache.ts",
    "src/values/keychain.ts",
    "src/values/sealed-blob-store.ts",
    "src/workflow/artifact.ts",
    "src/workflow/publish.ts",
    ]);
    const unexpected = offenders
      .map((o) => o.slice(0, o.lastIndexOf(":")))
      .filter((f) => f !== "src/runtime/paths.ts" && !KNOWN_NOT_YET_MIGRATED.has(f));
    expect([...new Set(unexpected)].sort()).toEqual([]);
  });

  test("the data root follows a runtime $HOME — os.homedir() does not", () => {
    // Measured under bun: setting process.env.HOME mid-process leaves
    // os.homedir() pointing at the ORIGINAL home. Sandboxes and tests relocate
    // a process exactly that way, and every caller that moved onto
    // getUnbrowseHome() had been reading process.env.HOME directly — so a
    // resolver built only on os.homedir() silently un-isolates them. Caught by
    // tests/indexer-dispatcher.test.ts ("HOME override writes envelope to queue
    // dir"), which passed before the migration and failed after it.
    const prevHome = process.env.HOME;
    const prevRoot = process.env.UNBROWSE_HOME;
    delete process.env.UNBROWSE_HOME;
    process.env.HOME = "/tmp/RUNTIME-HOME";
    try {
      expect(getUnbrowseHome()).toBe("/tmp/RUNTIME-HOME/.unbrowse");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevRoot !== undefined) process.env.UNBROWSE_HOME = prevRoot;
    }
  });

  test("UNBROWSE_HOME still outranks $HOME — the explicit knob wins", () => {
    const prevHome = process.env.HOME;
    const prevRoot = process.env.UNBROWSE_HOME;
    process.env.HOME = "/tmp/RUNTIME-HOME";
    process.env.UNBROWSE_HOME = "/tmp/EXPLICIT";
    try {
      expect(getUnbrowseHome()).toBe("/tmp/EXPLICIT");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevRoot === undefined) delete process.env.UNBROWSE_HOME;
      else process.env.UNBROWSE_HOME = prevRoot;
    }
  });

  test("UNBROWSE_HOME has ONE meaning: it IS the data root, never a home to append to", () => {
    // cli-v7/eval/settings.ts read it as a HOME and appended `.unbrowse`, so
    // settings resolved to $UNBROWSE_HOME/.unbrowse/ while _session.ts put its
    // sibling tmp/<sigHash>/ layout at $UNBROWSE_HOME/tmp/. Same env var, two
    // readings, and isolation silently half-applied.
    const prev = process.env.UNBROWSE_HOME;
    process.env.UNBROWSE_HOME = "/tmp/ISO-meaning";
    try {
      expect(getUnbrowseHome()).toBe("/tmp/ISO-meaning");
      expect(getCaptureSpoolDir()).toBe("/tmp/ISO-meaning/queue/capture-pending");
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_HOME;
      else process.env.UNBROWSE_HOME = prev;
    }
  });
});
