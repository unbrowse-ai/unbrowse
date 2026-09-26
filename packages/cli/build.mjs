// One Node bundle (the SDK is bundled in, so the CLI has no runtime dependencies) plus the agent skill.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
rmSync("dist", { recursive: true, force: true });
execFileSync("bun", ["build", "src/cli.ts", "--target", "node", "--outfile", "dist/cli.js", "--define", `__VERSION__=${JSON.stringify(version)}`], { stdio: "inherit" });
const cli = readFileSync("dist/cli.js", "utf8");
writeFileSync("dist/cli.js", cli.startsWith("#!") ? cli : `#!/usr/bin/env node\n${cli}`);
chmodSync("dist/cli.js", 0o755);
copyFileSync("../../skill/SKILL.md", "SKILL.md");
