// Build: dist/index.js is one Node ESM bundle (the Unbrowse SDK and the core tool schemas are bundled in, so the
// package has no runtime dependencies), and openclaw.plugin.json's contracts.tools is regenerated from the
// synced skill's tools.json. `--check` fails instead of writing when the manifest is stale.
// Run `node scripts/sync-plugins.mjs` at the repo root first to refresh skills/unbrowse.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const toolsPath = join(root, "skills/unbrowse/references/tools.json");
if (!existsSync(toolsPath)) {
  console.error("skills/unbrowse is missing: run `node scripts/sync-plugins.mjs` at the repo root");
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const safe = (n) => n.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
const tools = JSON.parse(readFileSync(toolsPath, "utf8")).tools.map((t) => safe(t.name));

const manifestPath = join(root, "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const next = { ...manifest, version, contracts: { ...manifest.contracts, tools } };
const text = `${JSON.stringify(next, null, 2)}\n`;
if (readFileSync(manifestPath, "utf8") !== text) {
  if (check) {
    console.error("openclaw.plugin.json is stale (contracts.tools or version): run `npm run build`");
    process.exit(1);
  }
  writeFileSync(manifestPath, text);
  console.log(`openclaw.plugin.json: ${tools.length} tools`);
}
if (check) {
  console.log("OPENCLAW_MANIFEST_OK");
  process.exit(0);
}

rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync("bun", ["build", "src/index.ts", "--target", "node", "--format", "esm", "--outfile", "dist/index.js", "--define", `__VERSION__=${JSON.stringify(version)}`], { cwd: root, stdio: "inherit" });
