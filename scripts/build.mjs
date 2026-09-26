// Build: one Node-compatible bundle for the CLI, the SDK as ESM, and type declarations.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
rmSync("dist", { recursive: true, force: true });
const bun = (args) => execFileSync("bun", args, { stdio: "inherit" });
bun(["build", "src/cli.ts", "--target", "node", "--outfile", "dist/cli.js", "--define", `__VERSION__=${JSON.stringify(version)}`]);
bun(["build", "src/index.ts", "--target", "node", "--outfile", "dist/index.js"]);
execFileSync("npx", ["tsc", "--emitDeclarationOnly", "--outDir", "dist"], { stdio: "inherit" });
const cli = readFileSync("dist/cli.js", "utf8");
writeFileSync("dist/cli.js", cli.startsWith("#!") ? cli : `#!/usr/bin/env node\n${cli}`);
chmodSync("dist/cli.js", 0o755);
