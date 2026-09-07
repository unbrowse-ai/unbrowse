#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the real CLI entrypoint. The package ships the readable bun runtime at
// `runtime/cli.js` (runnable on plain Node); older/dev layouts used `dist/cli.js`.
// Hardcoding `dist/cli.js` made this hook ENOENT silently on every shipped install
// — fall back across the known layouts and exit quietly if none is present.
const candidates = [
  join(__dirname, "..", "runtime", "cli.js"),
  join(__dirname, "..", "dist", "cli.js"),
];
const cliPath = candidates.find((p) => existsSync(p));
if (!cliPath) process.exit(0); // no runtime to drive — nothing to do, fail quiet

const child = spawn(process.execPath, [cliPath, "upgrade", "--hint-only"], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
