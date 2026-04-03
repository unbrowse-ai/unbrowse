#!/usr/bin/env node

import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(packageRoot, "dist");
const sourceDir = path.join(packageRoot, "src");
const runtimeSourceDir = path.join(packageRoot, "runtime-src");
const vendorKuriDir = path.join(packageRoot, "vendor", "kuri");
const binaryName = process.platform === "win32" ? "kuri.exe" : "kuri";
const supportedTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

function hasVendoredKuriBinaries() {
  return supportedTargets.every((target) => {
    try {
      readFileSync(path.join(vendorKuriDir, target, binaryName));
      return true;
    } catch {
      return false;
    }
  });
}

rmSync(distDir, { recursive: true, force: true });
rmSync(runtimeSourceDir, { recursive: true, force: true });

if (process.env.UNBROWSE_REBUILD_KURI === "1" || !hasVendoredKuriBinaries()) {
  execFileSync(process.execPath, [path.join(packageRoot, "scripts", "build-kuri-binaries.mjs")], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

const sharedArgs = ["build", "--target", "node", "--format", "esm", "--packages", "external"];

execFileSync(
  "bun",
  [...sharedArgs, path.join(sourceDir, "cli.ts"), "--outfile", path.join(distDir, "cli.js")],
  { cwd: packageRoot, stdio: "inherit" },
);

execFileSync(
  "bun",
  [...sharedArgs, path.join(sourceDir, "mcp.ts"), "--outfile", path.join(distDir, "mcp.js")],
  { cwd: packageRoot, stdio: "inherit" },
);

cpSync(sourceDir, runtimeSourceDir, { recursive: true, dereference: true });

const indexWrapper = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntrypoint = path.join(packageRoot, "runtime-src", "index.ts");
const req = createRequire(import.meta.url);
const tsxPkg = req.resolve("tsx/package.json");
const tsxLoader = path.join(path.dirname(tsxPkg), "dist", "loader.mjs");

const child = spawn(process.execPath, ["--import", tsxLoader, serverEntrypoint, ...process.argv.slice(2)], {
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
`;
writeFileSync(path.join(distDir, "index.js"), indexWrapper);

const cliFile = path.join(distDir, "cli.js");
const cliContents = readFileSync(cliFile, "utf8").replace(/^#!.*\n/, "");
writeFileSync(cliFile, `#!/usr/bin/env node\n${cliContents}`);

chmodSync(cliFile, 0o755);
chmodSync(path.join(distDir, "mcp.js"), 0o755);
chmodSync(path.join(distDir, "index.js"), 0o755);
