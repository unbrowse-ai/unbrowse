#!/usr/bin/env node

/**
 * Auditable runtime launcher.
 *
 * The package ships a READABLE, UNSIGNED runtime at `runtime/cli.js` (an
 * unminified bundle of the source, built `--target=node`) and runs it here under
 * the same Node that launched this script. The source IS the runtime, so the
 * client — including the zk/crypto verification path — is fully auditable on disk.
 * There is nothing to hide: every secret is wallet-sealed (AES-GCM under a key only
 * the holder derives), so reverse-engineering the client yields nothing. Security
 * lives in the wallet, not in obfuscation.
 *
 * No Bun is required at the user's runtime: the bundle runs on plain Node (>= 22.5,
 * for the built-in `node:sqlite` driver the route graph uses). If a compiled
 * single-file binary was injected via UNBROWSE_INSTALL_BINARY_PATH, the wrapper runs
 * that instead and never reaches this launcher.
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

if (!existsSync(runtime)) {
  fail("readable runtime missing (runtime/cli.js). Reinstall: npm install -g unbrowse@latest");
}

// The route graph uses Node's built-in node:sqlite (Node >= 22.5). Fail clearly,
// not with a cryptic module error, when the host Node is too old.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  fail(
    `unbrowse needs Node >= 22.5 (you have ${process.versions.node}). ` +
      `Upgrade Node (e.g. via nvm or https://nodejs.org), then re-run.`,
  );
}

const child = spawnSync(process.execPath, [runtime, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});
if (child.error) fail(`failed to launch runtime: ${child.error.message}`);
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
