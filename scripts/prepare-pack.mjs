#!/usr/bin/env node

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(packageRoot, "dist");
const sourceDir = path.join(packageRoot, "src");

rmSync(distDir, { recursive: true, force: true });

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

const cliFile = path.join(distDir, "cli.js");
const cliContents = readFileSync(cliFile, "utf8").replace(/^#!.*\n/, "");
writeFileSync(cliFile, `#!/usr/bin/env node\n${cliContents}`);

chmodSync(cliFile, 0o755);
