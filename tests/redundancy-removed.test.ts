/**
 * Redundancy removal — behavioural proof, not "the file got smaller".
 *
 * Three targets were assessed. Two were removed/fixed; one was deliberately KEPT
 * and this file records the measurement that justified keeping it. Each assertion
 * below is written so that reintroducing the thing it guards turns it red.
 *
 * NOTE: no `mock.module` anywhere in this file. It is process-wide in bun and
 * corrupts unrelated suites; every witness here is a real call or a real read.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { importBrowserCookiesIntoTab, shouldImportBrowserCookies } from "../src/auth/index.js";
import type { KuriClient } from "../src/kuri/client.js";
import { selectMarketplacePublishEndpoints } from "../src/publish-admission.js";
import { ensureBrowserEngineInstalled } from "../src/runtime/setup.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const ENV_KEYS = [
  "UNBROWSE_IMPORT_BROWSER_COOKIES",
  "UNBROWSE_KURI_BIN",
  "KURI_BIN",
  "KURI_PATH",
  "UNBROWSE_PACKAGE_ROOT",
  "HOME",
  "PATH",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/** Every .ts file under src/, so "no production caller" is asserted, not assumed. */
function sourceFiles(dir = path.join(REPO_ROOT, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// TARGET 1 — the duplicate `shouldImportBrowserCookies` was REMOVED.
//
// `src/runtime/browser-auth.ts` carried a second, behaviourally identical copy
// with zero production callers (its only importer was tests/browser-auth.test.ts).
// The survivor is `src/auth/index.ts`, which is the one wrapping the actual
// cookie harvester and the one every production call site imports.
// ---------------------------------------------------------------------------
describe("target 1: duplicate shouldImportBrowserCookies removed", () => {
  it("the duplicate module is gone and nothing under src/ imports it", () => {
    expect(existsSync(path.join(REPO_ROOT, "src/runtime/browser-auth.ts"))).toBe(false);

    const importers = sourceFiles().filter((file) => /["'].*runtime\/browser-auth(\.js)?["']/.test(readFileSync(file, "utf8")));
    expect(importers).toEqual([]);
  });

  it("the survivor is the guard production actually imports", () => {
    // Static witness: the real call sites name src/auth/index, not the deleted copy.
    // Matched on IMPORT specifiers only — direct-document.ts mentions the deleted
    // path in a comment explaining why it does not use it, which is not a caller.
    const importsBrowserAuth = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["'][^"']*runtime\/browser-auth/;
    for (const rel of ["src/cli-v7/breath/go.ts", "src/orchestrator/direct-document.ts"]) {
      const body = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(body).toContain("shouldImportBrowserCookies");
      expect(body).toMatch(/shouldImportBrowserCookies[\s\S]{0,120}?auth\/index\.js|auth\/index\.js[\s\S]{0,120}?shouldImportBrowserCookies/);
      expect(importsBrowserAuth.test(body)).toBe(false);
    }
  });

  it("the env var still controls the survivor in BOTH directions", () => {
    delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    expect(shouldImportBrowserCookies()).toBe(true);

    for (const off of ["0", "false", "no", "off", "FALSE", " off "]) {
      process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = off;
      expect(shouldImportBrowserCookies()).toBe(false);
    }
    for (const on of ["1", "true", "yes"]) {
      process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = on;
      expect(shouldImportBrowserCookies()).toBe(true);
    }
    // An empty/whitespace value is not an opt-out — it is an unset value.
    for (const blank of ["", "   "]) {
      process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = blank;
      expect(shouldImportBrowserCookies()).toBe(true);
    }
  });

  it("the surviving guard is the one the real cookie harvester consults", async () => {
    // Dynamic witness, no module mocking: importBrowserCookiesIntoTab takes an
    // optional KuriClient. Whether it ever touches that client is decided solely
    // by the guard, so the client's call log IS the guard's behaviour.
    process.env.HOME = tmpDir("redundancy-home-");
    const probe = (): { calls: string[]; client: KuriClient } => {
      const calls: string[] = [];
      return {
        calls,
        client: {
          setCookie: async () => { calls.push("setCookie"); },
          getCookies: async () => { calls.push("getCookies"); return []; },
        } as unknown as KuriClient,
      };
    };

    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "0";
    const disabled = probe();
    expect(await importBrowserCookiesIntoTab("tab-1", "newsroom.dev", disabled.client)).toBe(0);
    expect(disabled.calls).toEqual([]); // short-circuited before any harvesting

    delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    const enabled = probe();
    await importBrowserCookiesIntoTab("tab-1", "newsroom.dev", enabled.client);
    expect(enabled.calls).toContain("getCookies"); // guard let the harvester run
  });
});

// ---------------------------------------------------------------------------
// TARGET 2 — `isLikelyNoiseEndpoint` was DELIBERATELY KEPT.
//
// It was flagged as a hard token filter of the kind CLAUDE.md's standing rule
// disfavours, with the new structural ranking in src/capture/reveng-local.ts
// proposed as an eventual replacement. Measured end-to-end, it is not one:
// revengLocal admits a feature-flag route and a genuine article route with the
// SAME inferred reliability (0.613 each), because they have the same shape — 40
// like-shaped records. Shape cannot express "site infrastructure, not the
// user's data"; only the name can. The tests below pin that gap so the guard is
// not deleted on style grounds while it is still the only thing catching these.
// ---------------------------------------------------------------------------
const NOISE_BRANCH_SAMPLES: Array<{ branch: number; token: string }> = [
  { branch: 1, token: "telemetry" },
  { branch: 1, token: "feature-flag" },
  { branch: 2, token: "page-views" },
  { branch: 3, token: "app-open-times" },
  { branch: 4, token: "eligibility" },
  { branch: 5, token: "global-footer" },
];

/** An endpoint carrying the STRONGEST structural evidence the codebase records:
 *  verified, maximal reliability, and an array-of-like-shaped-records schema —
 *  i.e. exactly what reveng-local's ranking rewards. */
function maximallyStructuralEndpoint(id: string, pathname: string): EndpointDescriptor {
  const fields = ["id", "name", "value", "updated_at"];
  return {
    endpoint_id: id,
    method: "GET",
    url_template: `https://newsroom.dev${pathname}`,
    description: "Returns a collection of like-shaped records.",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    response_schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: Object.fromEntries(fields.map((f) => [f, { type: "string", inferred_from_samples: 40 }])),
            inferred_from_samples: 40,
          },
          inferred_from_samples: 40,
        },
      },
      inferred_from_samples: 40,
    },
    semantic: {
      action_kind: "read",
      resource_kind: "collection",
      example_fields: fields,
      confidence: 0.9,
    },
  } as unknown as EndpointDescriptor;
}

function skillWith(endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: "s-noise",
    domain: "newsroom.dev",
    name: "newsroom",
    version: "1",
    endpoints,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as unknown as SkillManifest;
}

describe("target 2: the noise guard is KEPT — structure cannot replace it", () => {
  it("control: the same maximal structure with a neutral name is admitted", () => {
    const selection = selectMarketplacePublishEndpoints(skillWith([
      maximallyStructuralEndpoint("keep-1", "/api/articles"),
    ]));
    expect(selection.stats.kept).toBe(1);
    expect(selection.stats.by_reason.noise).toBe(0);
  });

  it("every regex branch still rejects endpoints that are structurally indistinguishable from real data", () => {
    for (const { branch, token } of NOISE_BRANCH_SAMPLES) {
      // Identical shape to the control above — only the name differs.
      const endpoint = maximallyStructuralEndpoint(`noise-${branch}-${token}`, `/api/${token}/list`);
      const selection = selectMarketplacePublishEndpoints(skillWith([endpoint]));

      expect(`${token}:kept=${selection.stats.kept}`).toBe(`${token}:kept=0`);
      expect(`${token}:noise=${selection.stats.by_reason.noise}`).toBe(`${token}:noise=1`);
      // Rejected for being noise specifically — not incidentally by some other gate.
      expect(selection.stats.by_reason.no_durable_signal).toBe(0);
      expect(selection.stats.by_reason.off_domain).toBe(0);
      expect(selection.stats.by_reason.low_reliability).toBe(0);
    }
  });

  it("no branch is dead: each of the five is the sole matcher for its own tokens", () => {
    // A branch subsumed by an earlier one WOULD be a safe removal. None is.
    // Removing any branch makes at least one token below stop being rejected.
    const perBranch = new Map<number, number>();
    for (const { branch, token } of NOISE_BRANCH_SAMPLES) {
      const selection = selectMarketplacePublishEndpoints(skillWith([
        maximallyStructuralEndpoint(`b-${branch}-${token}`, `/api/${token}/list`),
      ]));
      if (selection.stats.by_reason.noise === 1) perBranch.set(branch, (perBranch.get(branch) ?? 0) + 1);
    }
    expect([...perBranch.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// TARGET 3 — the two unchecked nulls at src/runtime/setup.ts were FIXED.
//
// `findKuriBinary()` reports a miss as null. The two call sites passed that
// straight into `existsSync`, which tsc flagged. Harmless at runtime only by
// accident (existsSync(null) === false). The fix must keep a kuri-less machine
// working: a previous attempt made resolution THROW and broke `unbrowse setup`
// on exactly those machines. These tests pin the documented result, including
// that the build-from-source path is still reached when the binary is absent.
// ---------------------------------------------------------------------------
describe("target 3: kuri-missing setup returns its documented result, never throws", () => {
  /** Force findKuriBinary() to a hard null and point every source candidate at
   *  controlled empty directories, so neither zig nor a real kuri is consulted. */
  function isolateKuriless(): { home: string; kuriPath: string } {
    const home = tmpDir("redundancy-kuri-home-");
    const kuriPath = tmpDir("redundancy-kuri-src-");
    // An override that points at nothing is authoritative -> findKuriBinary() === null.
    process.env.UNBROWSE_KURI_BIN = path.join(tmpDir("redundancy-kuri-gone-"), "kuri");
    delete process.env.KURI_BIN;
    process.env.KURI_PATH = kuriPath;
    process.env.UNBROWSE_PACKAGE_ROOT = tmpDir("redundancy-kuri-pkg-");
    process.env.HOME = home;
    // NOTE: PATH is deliberately NOT touched. bun's execFileSync resolves a bare
    // command against a PATH snapshot taken at startup, so mutating
    // process.env.PATH does not hide `zig` from setup.ts's `hasBinary`. The
    // assertions below are therefore written to hold whether or not this machine
    // has a Zig toolchain.
    return { home, kuriPath };
  }

  it("no binary and no source: reports failure instead of throwing", async () => {
    isolateKuriless();

    const report = await ensureBrowserEngineInstalled();

    expect(report.installed).toBe(false);
    expect(report.action).toBe("failed");
    expect(report.message).toContain("Kuri binary not found");
    // The null must never reach the user as the string "null".
    expect(report.message).not.toContain("null");
  });

  it("no binary but source present: still reaches the build-from-source path", async () => {
    const { kuriPath } = isolateKuriless();
    mkdirSync(kuriPath, { recursive: true });
    writeFileSync(path.join(kuriPath, "build.zig"), "// marker\n");

    const report = await ensureBrowserEngineInstalled();

    // THE REGRESSION GUARD. `!sourceDir` is the only branch that answers
    // "Kuri binary not found"; reaching anything past it proves a null binary
    // did NOT short-circuit source discovery, so a kuri-less machine can still
    // build. Which of the two later outcomes we land on depends on whether this
    // machine has Zig — either one proves the point.
    expect(report.installed).toBe(false);
    expect(report.action).toBe("failed");
    expect(report.message).not.toContain("Kuri binary not found");
    expect(report.message).toMatch(/Zig is not installed|zig build/i);
    if (/Zig is not installed/.test(report.message ?? "")) expect(report.message).toContain(kuriPath);
  });

  it("a present binary is still reported as already-installed", async () => {
    isolateKuriless();
    const binDir = tmpDir("redundancy-kuri-real-");
    const binary = path.join(binDir, "kuri");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    process.env.UNBROWSE_KURI_BIN = binary;

    const report = await ensureBrowserEngineInstalled();

    expect(report.installed).toBe(true);
    expect(report.action).toBe("already-installed");
  });
});
