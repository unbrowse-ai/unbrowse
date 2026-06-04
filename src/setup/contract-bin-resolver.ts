// Resolve a runnable /contract binary on the user's machine.
//
// The /contract primitive ships in three places today:
//   - $CONTRACT_BIN env override (explicit user wiring)
//   - a system-wide Rust `forge_contract` binary on PATH (`which contract`)
//   - ~/.cargo/bin/contract  (cargo install fallback)
//   - ~/(internal)  (Python CLI, canonical;
//     always present if Claude Code is installed — the install precondition
//     unbrowse setup leans on for D3')
//
// This module surfaces whichever one is present — it never installs, never
// downloads, never bundles. If none are present, returns `null` and the
// caller reports `not_detected` (mirroring the existing host-register
// vocabulary).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export interface ContractBinResolution {
  /** Absolute path to a runnable /contract binary, or null when none found. */
  path: string | null;
  /** Which probe matched. Useful for `unbrowse setup` reporting. */
  source:
    | "env"
    | "path"
    | "cargo"
    | "claude-skill"
    | "not_detected";
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // We don't strictly need the +x bit — the CLI fallback is a Python script
    // we'll invoke via the shebang at the top of the file. existsSync was
    // already enough, but stat-and-check makes the failure mode louder.
    return true;
  } catch {
    return false;
  }
}

function whichContract(): string | null {
  // Prefer POSIX `which`; fall back to `command -v` if `which` is absent.
  const probes: Array<{ cmd: string; args: string[] }> = [
    { cmd: "which", args: ["contract"] },
    { cmd: "command", args: ["-v", "contract"] },
  ];
  for (const probe of probes) {
    try {
      const r = spawnSync(probe.cmd, probe.args, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
      if (r.status === 0) {
        const out = (r.stdout?.toString() ?? "").trim().split("\n")[0]?.trim();
        if (out && isExecutableFile(out)) return out;
      }
    } catch {
      // try the next probe
    }
  }
  return null;
}

export interface ResolveOptions {
  /** Override $HOME (tests). */
  homeDir?: string;
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv;
  /** Disable the `which` probe (tests — keeps unit tests hermetic). */
  skipWhich?: boolean;
}

export function resolveContractBin(opts: ResolveOptions = {}): ContractBinResolution {
  const home = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;

  // 1. Explicit env override.
  const envBin = env.CONTRACT_BIN;
  if (envBin && isExecutableFile(envBin)) {
    return { path: envBin, source: "env" };
  }

  // 2. Anything on PATH named `contract`.
  if (!opts.skipWhich) {
    const onPath = whichContract();
    if (onPath) return { path: onPath, source: "path" };
  }

  // 3. ~/.cargo/bin/contract — forge_contract Rust binary.
  const cargo = join(home, ".cargo", "bin", "contract");
  if (isExecutableFile(cargo)) {
    return { path: cargo, source: "cargo" };
  }

  // 4. ~/(internal) — Python CLI, canonical.
  const claude = join(home, "(internal)", "skills", "contract", "scripts", "contract");
  if (isExecutableFile(claude)) {
    return { path: claude, source: "claude-skill" };
  }

  return { path: null, source: "not_detected" };
}
