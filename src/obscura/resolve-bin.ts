/**
 * Pure, testable path helpers for locating the two obscura binaries that back
 * the Chrome-free browser stack:
 *
 *   - `obscura`          the shipped CLI/MCP engine (render, interact, stealth TLS)
 *   - `obscura-capture`  the route-learning sidecar (on_request/on_response capture)
 *
 * Neither launches Chrome and neither speaks CDP. Resolution order, first hit wins:
 *   1. explicit env override (UNBROWSE_OBSCURA_BIN / UNBROWSE_OBSCURA_CAPTURE_BIN)
 *   2. a binary sitting next to the running unbrowse executable
 *   3. the vendored tree (vendor/obscura/<target>/...), mirroring the kuri layout
 *   4. bare name on PATH (dev machines with `cargo install`/release on PATH)
 *
 * Mirrors src/kuri/resolve-paths.ts so the single-binary entrypoint, CLI, and
 * capture path all agree, and so the logic unit-tests on any host.
 */

import { join } from "node:path";

export type ObscuraBin = "obscura" | "obscura-capture";

/** On-disk filename for an obscura binary on a given `process.platform`. */
export function obscuraBinaryName(
  bin: ObscuraBin,
  platform: string = process.platform,
): string {
  return platform === "win32" ? `${bin}.exe` : bin;
}

/**
 * Vendored-binary target id (e.g. `linux-x64`) for a platform/arch pair, or null
 * when no prebuilt obscura exists. Matches the ids obscura publishes on its
 * GitHub releases (x86_64/aarch64 × linux/macos), remapped to node's
 * platform/arch vocabulary and the kuri-style `<os>-<arch>` folder convention.
 */
export function obscuraTargetKey(
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

/** The env var that force-overrides the path to a given obscura binary. */
export function obscuraEnvVar(bin: ObscuraBin): string {
  return bin === "obscura"
    ? "UNBROWSE_OBSCURA_BIN"
    : "UNBROWSE_OBSCURA_CAPTURE_BIN";
}

/**
 * Ordered candidate paths for an obscura binary, most-specific first. `execDir`
 * is the directory of the running binary (`dirname(process.execPath)`);
 * `moduleDir` reaches the vendored obscura tree in source / npm-package layouts.
 * `env` defaults to `process.env` and lets tests inject overrides.
 */
export function obscuraVendorCandidatePaths(opts: {
  bin: ObscuraBin;
  execDir: string;
  moduleDir?: string;
  platform?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const env = opts.env ?? process.env;
  const name = obscuraBinaryName(opts.bin, platform);
  const target = obscuraTargetKey(platform, arch);
  const out: string[] = [];

  const override = env[obscuraEnvVar(opts.bin)];
  if (override) out.push(override);

  out.push(join(opts.execDir, name));

  if (opts.moduleDir && target) {
    // Walk UP from the module rather than guessing one fixed depth. The vendor
    // tree sits at the repo/package ROOT, and moduleDir differs per layout:
    // `src/capture/` when running from source, `runtime/` when packaged. A
    // single `..` was correct for the packaged layout and one level short from
    // source, so every source-run candidate missed and resolution fell through
    // to a bare PATH lookup — measured: "Executable not found in $PATH:
    // obscura-capture", with the binary present at <repo>/vendor the whole time.
    // Bounded to 4 levels: enough for src/<area>/ and runtime/, never a walk to /.
    for (let up = 1; up <= 4; up++) {
      const root = join(opts.moduleDir, ...Array<string>(up).fill(".."));
      // Stop at the filesystem root. `join` CLAMPS at "/", so a shallow
      // moduleDir makes deeper levels collapse onto each other and propose
      // "/vendor/..." — both a duplicate probe and a search outside the project.
      // Caught by the guard: the first version proposed exactly that.
      if (root === "/" || root === ".") break;
      out.push(join(root, "vendor", "obscura", target, name));
      out.push(join(root, "packages", "skill", "vendor", "obscura", target, name));
    }
  }

  // Bare name on PATH is the final fallback (dev boxes with obscura installed).
  out.push(name);
  // Preserve precedence, probe each path once.
  return [...new Set(out)];
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
