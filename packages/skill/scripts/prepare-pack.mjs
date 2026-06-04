#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBrokenMonorepoKuri } from "./lib/kuri-vendor.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(packageRoot, "../..");
const distDir = path.join(packageRoot, "dist");
const sourceDir = path.join(packageRoot, "src");
const runtimeSourceDir = path.join(packageRoot, "runtime-src");
const packagedBinaryPath = path.join(packageRoot, "bin", "unbrowse");
// W13.1 — utls-proxy vendor lane (mirrors kuri pattern, but honest-fall-through).
const utlsVendorDir = path.join(packageRoot, "vendor", "utls-proxy");
const utlsDistDir = path.join(repoRoot, "submodules", "utls-proxy", "dist");

rmSync(distDir, { recursive: true, force: true });
rmSync(runtimeSourceDir, { recursive: true, force: true });
rmSync(packagedBinaryPath, { force: true });

if (detectBrokenMonorepoKuri(packageRoot, repoRoot)) {
  throw new Error(
    "Broken Kuri source checkout at submodules/kuri. Reinit the submodule or set UNBROWSE_KURI_SOURCE_DIR to a clean justrach/kuri checkout.",
  );
}

execFileSync("bun", [path.join(repoRoot, "scripts", "build-release-manifest.ts")], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

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
  [...sharedArgs, path.join(sourceDir, "mcp.ts"), "--outfile", path.join(distDir, "mcp.js")],
  { cwd: packageRoot, stdio: "inherit" },
);

execFileSync(
  "bun",
  [...sharedArgs, path.join(sourceDir, "index.ts"), "--outfile", path.join(distDir, "server.js")],
  { cwd: packageRoot, stdio: "inherit" },
);

cpSync(sourceDir, runtimeSourceDir, { recursive: true, dereference: true });

const indexWrapper = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntrypoint = path.join(packageRoot, "dist", "server.js");

const child = spawn(process.execPath, [serverEntrypoint, ...process.argv.slice(2)], {
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

// W13.1 — vendor the utls-proxy binaries that build.sh produced under
// submodules/utls-proxy/dist/. Honest fall-through: if dist is empty
// (build wasn't run), skip silently — the runtime degrades to iproyal-only.
// Mirror the kuri-vendor pattern, but lenient (utls-proxy is an optional
// layer; kuri is required).
if (existsSync(utlsDistDir)) {
  mkdirSync(utlsVendorDir, { recursive: true });
  const targets = [
    "utls-proxy-darwin-arm64",
    "utls-proxy-darwin-amd64",
    "utls-proxy-linux-amd64",
    "utls-proxy-linux-arm64",
  ];
  let vendored = 0;
  for (const bin of targets) {
    const src = path.join(utlsDistDir, bin);
    if (existsSync(src)) {
      const dest = path.join(utlsVendorDir, bin);
      cpSync(src, dest);
      chmodSync(dest, 0o755);
      vendored += 1;
    }
  }
  console.log(`[prepare-pack] vendored ${vendored}/${targets.length} utls-proxy binaries`);
} else {
  console.log(
    "[prepare-pack] submodules/utls-proxy/dist/ missing — skipping utls vendor (runtime falls through to no-TLS-spoof). Build via 'bash submodules/utls-proxy/build.sh' before publish.",
  );
}
