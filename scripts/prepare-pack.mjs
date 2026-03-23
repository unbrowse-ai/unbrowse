#!/usr/bin/env node

import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(packageRoot, "dist");
const sourceDir = path.join(packageRoot, "src");
const runtimeSourceDir = path.join(packageRoot, "runtime-src");

rmSync(distDir, { recursive: true, force: true });
rmSync(runtimeSourceDir, { recursive: true, force: true });

execFileSync(process.execPath, [path.join(packageRoot, "scripts", "build-kuri-binaries.mjs")], {
  cwd: packageRoot,
  stdio: "inherit",
});

const sharedArgs = ["build", "--target", "node", "--format", "esm", "--packages", "external"];

execFileSync(
  "bun",
  [...sharedArgs, path.join(sourceDir, "cli.ts"), "--outfile", path.join(distDir, "cli.js")],
  { cwd: packageRoot, stdio: "inherit" },
);

execFileSync(
  "bun",
  [...sharedArgs, path.join(sourceDir, "index.ts"), "--outfile", path.join(distDir, "index.js")],
  { cwd: packageRoot, stdio: "inherit" },
);

cpSync(sourceDir, runtimeSourceDir, { recursive: true, dereference: true });

const cliFile = path.join(distDir, "cli.js");
const cliContents = readFileSync(cliFile, "utf8").replace(/^#!.*\n/, "");
writeFileSync(cliFile, `#!/usr/bin/env node\n${cliContents}`);

const indexFile = path.join(distDir, "index.js");
const indexContents = readFileSync(indexFile, "utf8").replace(/^#!.*\n/, "");
writeFileSync(indexFile, `#!/usr/bin/env node\n${indexContents}`);

chmodSync(cliFile, 0o755);
chmodSync(indexFile, 0o755);
