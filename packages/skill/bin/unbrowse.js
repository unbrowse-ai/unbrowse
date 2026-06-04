#!/usr/bin/env node

/**
 * Auditable runtime launcher.
 *
 * The package ships a READABLE, UNSIGNED runtime at `runtime/cli.js` (an
 * unminified Bun bundle of the source) and runs it here. The source IS the
 * runtime, so the client — including the zk/crypto verification path — is fully
 * auditable on disk. There is nothing to hide: every secret is wallet-sealed
 * (AES-GCM under a key only the holder derives), so reverse-engineering the
 * client yields nothing. Security lives in the wallet, not in obfuscation.
 *
 * The runtime requires Bun. If a compiled binary was downloaded post-install,
 * the wrapper runs that instead and never reaches this launcher.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "..", "runtime", "cli.js");

function fail(msg, code = 1) {
  process.stderr.write(`[unbrowse] ${msg}\n`);
  process.exit(code);
}

function findBun() {
  const candidates = [
    process.env.UNBROWSE_BUN_BIN,
    "bun",
    join(process.env.HOME || "", ".bun", "bin", "bun"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
      if (probe.status === 0) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

if (!existsSync(runtime)) {
  fail("readable runtime missing (runtime/cli.js). Reinstall: npm install -g unbrowse@latest");
}

const bun = findBun();
if (!bun) {
  fail("this build runs on Bun. Install it from https://bun.sh, then re-run (or set UNBROWSE_BUN_BIN).");
}

const child = spawnSync(bun, [runtime, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});
if (child.error) fail(`failed to launch runtime: ${child.error.message}`);
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
