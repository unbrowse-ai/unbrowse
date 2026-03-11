#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distEntrypoint = path.join(packageRoot, "dist", "cli.js");
const cliEntrypoint = existsSync(distEntrypoint)
  ? distEntrypoint
  : path.join(packageRoot, "src", "cli.ts");
const cliArgs = cliEntrypoint.endsWith(".js")
  ? [cliEntrypoint, ...process.argv.slice(2)]
  : (() => {
      const req = createRequire(import.meta.url);
      const tsxPkg = req.resolve("tsx/package.json");
      const tsxLoader = path.join(path.dirname(tsxPkg), "dist", "loader.mjs");
      return ["--import", tsxLoader, cliEntrypoint, ...process.argv.slice(2)];
    })();
const req = createRequire(import.meta.url);
const child = spawn(process.execPath, cliArgs, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: {
    ...process.env,
    UNBROWSE_PACKAGE_ROOT: packageRoot,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
