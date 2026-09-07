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
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Run the runtime IN THIS PROCESS.
//
// This used to be `spawnSync(process.execPath, [runtime, ...])`, which was the
// single worst hop in the chain. spawnSync blocks the event loop for the entire
// lifetime of the child, so this process could never react to anything while the
// runtime ran: a SIGTERM handler registered here could not have executed even if
// one had been written. Signal forwarding was not merely omitted, it was
// structurally impossible — and a client that killed this process therefore
// orphaned the runtime and everything the runtime had spawned.
//
// There is nothing to spawn for. The bundle is plain ESM targeted at Node, and
// we have already verified the Node running THIS file satisfies its version
// floor, so it is the correct interpreter by construction. Importing makes the
// runtime this process: one PID, signals land where the work happens, and the
// exit code is whatever the runtime sets.
//
// argv is rewritten to the exact shape the spawn produced. The runtime decides
// whether to auto-run main() by comparing process.argv[1] against its own module
// path (isMainModule, src/runtime/paths.ts) — leave argv[1] pointing at this
// launcher and the CLI would start up and silently do nothing.
process.argv = [process.execPath, runtime, ...process.argv.slice(2)];
try {
  await import(pathToFileURL(runtime).href);
} catch (error) {
  fail(`failed to launch runtime: ${error instanceof Error ? error.message : String(error)}`);
}
