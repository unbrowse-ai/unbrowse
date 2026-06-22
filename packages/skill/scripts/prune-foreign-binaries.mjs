#!/usr/bin/env node
/**
 * prune-foreign-binaries.mjs — konmari: after install, keep only THIS host's vendored
 * native binaries (kuri, utls-proxy) and delete the other platforms'. The runtime resolver
 * picks host-by-name (src/kuri/client.ts → vendor/kuri/<platform>-<arch>/;
 * src/cdp/proxy/utls-daemon.ts → vendor/utls-proxy/utls-proxy-<platform>-<goarch>), so the
 * foreign binaries are provably unused on this machine — ~40 MB of dead weight per install.
 *
 * Fail-safe (Luke 15:4): if the host's own binary is ABSENT, prune NOTHING — never orphan the
 * CLI. Idempotent (only deletes non-host entries). Opt out with UNBROWSE_NO_PRUNE=1.
 */
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootArgIdx = process.argv.indexOf("--root");
const root = rootArgIdx !== -1 ? process.argv[rootArgIdx + 1]
  : join(dirname(fileURLToPath(import.meta.url)), ".."); // scripts/ -> package root

const platform = process.platform;
const arch = process.arch;
const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
// Match the runtime resolver EXACTLY (src/kuri/client.ts: win32+x64 → "win-x64", NOT
// "win32-x64"); a mismatch here makes the prune inert on that platform (or, worse, treat the
// host's own dir as foreign). Mirror currentBundledKuriTarget().
const hostKuriDir = (platform === "win32" && arch === "x64") ? "win-x64" : `${platform}-${arch}`;
const hostUtlsBin = `utls-proxy-${platform}-${goarch}`; // resolver uses the same raw formula (utls-daemon.ts)

// Restore the executable bit on THIS host's vendored binaries — npm/CI packaging
// can ship them mode 0644 (the linux-x64 kuri does), and `spawn(kuri) EACCES` then
// crashes the CLI with an unhandled 'error' event on the next browse/fetch. The +x
// is NOT optional, so this runs even under UNBROWSE_NO_PRUNE. Best-effort: a chmod
// must never break install.
try {
  const kuriBin = join(root, "vendor", "kuri", hostKuriDir, platform === "win32" ? "kuri.exe" : "kuri");
  if (existsSync(kuriBin)) chmodSync(kuriBin, 0o755);
  const utlsBin = join(root, "vendor", "utls-proxy", hostUtlsBin);
  if (existsSync(utlsBin)) chmodSync(utlsBin, 0o755);
} catch { /* never break install on a chmod */ }

if (process.env.UNBROWSE_NO_PRUNE === "1") process.exit(0);

// Source/monorepo checkouts build src/single-binary.ts directly. That file
// statically imports every platform's vendored Kuri asset so Bun can compile
// any target from the checkout. npm package installs may safely prune foreign
// platforms, but source checkouts must keep them or Windows builds fail after
// `bun install` with "Could not resolve ... vendor/kuri/darwin-arm64/kuri".
// Keep the chmod repair above, skip only deletion. UNBROWSE_FORCE_PRUNE=1 is a
// manual override for local size experiments.
if (
  process.env.UNBROWSE_FORCE_PRUNE !== "1" &&
  existsSync(join(root, "..", "..", "src", "single-binary.ts"))
) {
  process.exit(0);
}

const du = (p) => {
  try { return statSync(p).isDirectory() ? readdirSync(p).reduce((a, f) => a + du(join(p, f)), 0) : statSync(p).size; }
  catch { return 0; }
};

let freed = 0;

// kuri: keep the host platform dir, delete the others — only if the host dir exists
const kuriDir = join(root, "vendor", "kuri");
if (existsSync(join(kuriDir, hostKuriDir))) {
  for (const name of readdirSync(kuriDir)) {
    const p = join(kuriDir, name);
    if (name !== hostKuriDir && existsSync(p) && statSync(p).isDirectory()) {
      freed += du(p); rmSync(p, { recursive: true, force: true });
    }
  }
}

// contract: keep the host platform dir (the embedded libcontract), delete the others.
// Same <platform>-<arch> / win-x64 convention as kuri (src/values/contract-native.ts
// resolver). Only if the host dir exists (fail-safe); manifest.json is a file, never pruned.
const contractDir = join(root, "vendor", "contract");
if (existsSync(join(contractDir, hostKuriDir))) {
  for (const name of readdirSync(contractDir)) {
    const p = join(contractDir, name);
    if (name !== hostKuriDir && existsSync(p) && statSync(p).isDirectory()) {
      freed += du(p); rmSync(p, { recursive: true, force: true });
    }
  }
}

// utls-proxy: keep the host binary, delete the other utls-proxy-* binaries — only if host exists
const utlsDir = join(root, "vendor", "utls-proxy");
if (existsSync(join(utlsDir, hostUtlsBin))) {
  for (const name of readdirSync(utlsDir)) {
    if (name.startsWith("utls-proxy-") && name !== hostUtlsBin) {
      const p = join(utlsDir, name); freed += du(p); rmSync(p, { force: true });
    }
  }
}

if (freed > 0) {
  console.error(`[unbrowse] konmari: pruned ${(freed / 1048576).toFixed(1)} MB of foreign-platform binaries (kept ${hostKuriDir} / ${hostUtlsBin})`);
}
