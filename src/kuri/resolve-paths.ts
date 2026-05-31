/**
 * Pure, testable path helpers for locating the kuri broker binary.
 *
 * Kuri is `kuri` on darwin/linux and `kuri.exe` on Windows. These helpers keep
 * the platform decisions in one place so the single-binary entrypoint, the CLI,
 * and the auto-spawn path all agree — and so the logic can be unit-tested on any
 * host without a Windows machine.
 */

import { join } from "node:path";

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
