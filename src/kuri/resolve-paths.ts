/**
 * Pure, testable path helpers for locating the kuri broker binary.
 *
 * Kuri is `kuri` on darwin/linux and `kuri.exe` on Windows. These helpers keep
 * the platform decisions in one place so the single-binary entrypoint, the CLI,
 * and the auto-spawn path all agree — and so the logic can be unit-tested on any
 * host without a Windows machine.
 */

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { getPackageRoot } from "../runtime/paths.js";

/** The on-disk filename of the kuri binary for a given `process.platform`. */
export function kuriBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "kuri.exe" : "kuri";
}

/**
 * The vendored-binary target id (e.g. `win-x64`) for a platform/arch pair, or
 * null when no prebuilt kuri exists for the combination. Mirrors the target ids
 * used under packages/skill/vendor/kuri/<id>/.
 */
export function kuriTargetKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  return null;
}

/**
 * Ordered candidate paths to look for a kuri binary that ships alongside or is
 * vendored near the running unbrowse binary. The first existing one wins.
 *
 * `execDir` is the directory of the running binary (process.execPath dir);
 * `moduleDir` is this module's directory (used to reach the vendored kuri tree
 * in source / npm-package layouts).
 */
export function kuriVendorCandidatePaths(opts: {
  execDir: string;
  moduleDir?: string;
  platform?: string;
  arch?: string;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const bin = kuriBinaryName(platform);
  const target = kuriTargetKey(platform, arch);
  const out: string[] = [join(opts.execDir, bin)];
  if (opts.moduleDir && target) {
    out.push(join(opts.moduleDir, "..", "vendor", "kuri", target, bin));
    out.push(join(opts.moduleDir, "..", "packages", "skill", "vendor", "kuri", target, bin));
  }
  return out;
}

/** First path in `candidates` for which `exists(path)` is true, else null. */
export function firstExisting(
  candidates: Array<string | undefined | null>,
  exists: (p: string) => boolean,
): string | null {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker-binary resolution.
//
// Moved here from `client.ts`, where it sat inside 2,543 lines of browser
// control it had nothing to do with — it is pure path logic, and this file's
// whole purpose is "keep the platform decisions in one place". Two functions
// were duplicated across the split: `kuriBinaryName` existed verbatim in both,
// and `currentBundledKuriTarget` was a second copy of `kuriTargetKey`. Both
// copies are gone; the canonical ones above are used instead.
//
// This is also what lets `src/runtime/setup.ts` stop importing the browser
// client just to find a binary path.
// ─────────────────────────────────────────────────────────────────────────────
export interface KuriBinaryLookup {
  env?: Record<string, string | undefined>;
  /** Home directory that contains `.unbrowse/bin/` (the installer's target). */
  home?: string;
  packageRoot?: string;
  platform?: string;
  arch?: string;
  exists?: (candidate: string) => boolean;
  lookupOnPath?: (name: string) => string | null;
}

/** The env vars that explicitly pin the kuri binary, highest priority first. */
export const KURI_BINARY_ENV_VARS = ["UNBROWSE_KURI_BIN", "KURI_BIN"] as const;

function resolveBinaryOnPath(name: string, platform: string = process.platform): string | null {
  const checker = platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(checker, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return match || null;
  } catch {
    return null;
  }
}

function addCandidate(candidates: string[], candidate?: string | null): void {
  if (!candidate) return;
  if (!candidates.includes(candidate)) candidates.push(candidate);
}

/** Resolve the ambient inputs once so every helper sees the same view. */
export function resolveLookup(lookup: KuriBinaryLookup = {}): Required<KuriBinaryLookup> {
  const env = lookup.env ?? (process.env as Record<string, string | undefined>);
  const platform = lookup.platform ?? process.platform;
  return {
    env,
    home: lookup.home ?? env.HOME ?? homedir(),
    packageRoot: lookup.packageRoot ?? getPackageRoot(import.meta.url),
    platform,
    arch: lookup.arch ?? process.arch,
    exists: lookup.exists ?? existsSync,
    lookupOnPath: lookup.lookupOnPath ?? ((name: string) => resolveBinaryOnPath(name, platform)),
  };
}

export function getKuriSourceCandidates(lookup: KuriBinaryLookup = {}): string[] {
  const { env, home, packageRoot } = resolveLookup(lookup);
  const candidates: string[] = [];
  addCandidate(candidates, path.join(packageRoot, "vendor", "kuri-src"));
  addCandidate(candidates, path.join(packageRoot, "submodules", "kuri"));
  if (env.KURI_PATH) addCandidate(candidates, env.KURI_PATH);
  if (home) addCandidate(candidates, path.join(home, "kuri"));
  return candidates;
}

/**
 * Where `unbrowse`'s own installer puts the kuri binary.
 *
 * Single source of truth mirrored from `src/single-binary.ts`, which extracts
 * the embedded kuri to `~/.unbrowse/bin/<kuri|kuri.exe>` on first run and logs
 * `[unbrowse] extracted kuri to <path>`. The broker resolver must agree with
 * the installer, otherwise a correctly-installed kuri is invisible here.
 */
export function getInstalledKuriBinaryPath(lookup: KuriBinaryLookup = {}): string {
  const { home, platform } = resolveLookup(lookup);
  return path.join(home, ".unbrowse", "bin", kuriBinaryName(platform));
}

/**
 * The explicit env override, if the caller pinned one.
 *
 * `UNBROWSE_KURI_BIN` wins over `KURI_BIN`, matching the order already used by
 * the CLI auto-spawn (`src/cli.ts`) and the sandbox auto-spawn
 * (`src/kuri/spawn.ts`). An override that is set is AUTHORITATIVE: if it points
 * at nothing we fail naming it rather than silently substituting some other
 * binary the user did not ask for.
 */
export function getKuriBinaryOverride(
  lookup: KuriBinaryLookup = {},
): { name: string; value: string } | null {
  const { env } = resolveLookup(lookup);
  for (const name of KURI_BINARY_ENV_VARS) {
    const value = env[name];
    if (value) return { name, value };
  }
  return null;
}

export function getKuriBinaryCandidates(lookup: KuriBinaryLookup = {}): string[] {
  const resolved = resolveLookup(lookup);
  const { packageRoot, platform, arch, lookupOnPath } = resolved;
  const binaryName = kuriBinaryName(platform);
  const target = kuriTargetKey(platform, arch);
  const candidates: string[] = [];

  // 0. Explicit overrides first, so the searched-path list we report on failure
  //    names them too.
  const override = getKuriBinaryOverride(lookup);
  if (override) addCandidate(candidates, override.value);

  if (target) addCandidate(candidates, path.join(packageRoot, "vendor", "kuri", target, binaryName));
  if (target) addCandidate(candidates, path.join(packageRoot, "packages", "skill", "vendor", "kuri", target, binaryName));
  // The bundled runtime ships under `<pkg>/runtime/` with its own package.json,
  // so getPackageRoot() resolves to the runtime dir while the vendored kuri tree
  // lives one level up at `<pkg>/vendor/kuri/<target>/` (true in both the dev
  // checkout — packages/skill/runtime + packages/skill/vendor/kuri — and the
  // published package — <pkg>/runtime + <pkg>/vendor/kuri). Probe the parent so
  // this broker resolver agrees with the cli auto-spawn and kuriVendorCandidatePaths.
  if (target) addCandidate(candidates, path.join(packageRoot, "..", "vendor", "kuri", target, binaryName));
  if (target) addCandidate(candidates, path.join(packageRoot, "..", "packages", "skill", "vendor", "kuri", target, binaryName));
  // The installer's target (`~/.unbrowse/bin/kuri`). Ranked after the vendored
  // trees because those are version-matched to the running unbrowse, and before
  // source builds / PATH because it is a managed install rather than a dev or
  // system artifact. Without this entry a correctly-installed kuri was invisible
  // to the broker and capture died claiming "no endpoints discovered".
  addCandidate(candidates, getInstalledKuriBinaryPath(lookup));
  for (const sourceDir of getKuriSourceCandidates(lookup)) {
    addCandidate(candidates, path.join(sourceDir, "zig-out", "bin", binaryName));
  }
  addCandidate(candidates, lookupOnPath("kuri"));
  return candidates;
}

/**
 * Find the kuri binary, or null when none exists.
 *
 * A returned string is ALWAYS a path that existed at resolution time. That was
 * the bug: on a miss the resolver ended in `?? candidates[0]` and handed back a
 * path it had just proved absent, so callers "found" a binary that could not be
 * spawned and the failure surfaced downstream as a misleading "no endpoints
 * discovered; site may need authentication or different intent".
 *
 * `string | null` matches the sibling resolver in `src/single-binary.ts`, which
 * has always reported a miss as null — this copy was the odd one out.
 * Callers that cannot proceed without a binary should use `requireKuriBinary`.
 */
export function findKuriBinary(lookup: KuriBinaryLookup = {}): string | null {
  const { exists } = resolveLookup(lookup);
  // An explicit override is authoritative: honour it, or report a miss naming
  // it. Falling through to auto-discovery would silently run a binary the caller
  // did not ask for, which is the same class of lie this function exists to
  // prevent.
  const override = getKuriBinaryOverride(lookup);
  if (override) return exists(override.value) ? override.value : null;
  return getKuriBinaryCandidates(lookup).find((candidate) => exists(candidate)) ?? null;
}

/** Thrown when no kuri binary exists at any searched location. */
export class KuriBinaryNotFoundError extends Error {
  /** Every path that was probed, in resolution order. */
  readonly searched: string[];
  /** The env var that pinned the (missing) binary, when one was set. */
  readonly overrideVar: string | null;

  constructor(message: string, searched: string[], overrideVar: string | null) {
    super(message);
    this.name = "KuriBinaryNotFoundError";
    this.searched = searched;
    this.overrideVar = overrideVar;
  }
}

function formatKuriNotFound(searched: string[], override: { name: string; value: string } | null): string {
  const list = searched.map((candidate) => `  - ${candidate}`).join("\n");
  if (override) {
    return `Kuri binary not found at ${override.value} (from ${override.name}). `
      + `Point ${override.name} at an existing kuri binary, or unset it to search standard paths:\n${list}`;
  }
  return "Kuri binary not found in standard paths. "
    + `Set ${KURI_BINARY_ENV_VARS[0]}, or run: submodules/kuri/zig-out/bin/kuri\nSearched:\n${list}`;
}

/**
 * Find the kuri binary, or throw naming every path searched and the env var
 * that overrides them. The returned string is guaranteed to exist on disk.
 */
export function requireKuriBinary(lookup: KuriBinaryLookup = {}): string {
  const found = findKuriBinary(lookup);
  if (found) return found;
  const override = getKuriBinaryOverride(lookup);
  const searched = getKuriBinaryCandidates(lookup);
  throw new KuriBinaryNotFoundError(formatKuriNotFound(searched, override), searched, override?.name ?? null);
}
