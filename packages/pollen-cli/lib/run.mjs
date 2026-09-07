#!/usr/bin/env node
/**
 * Thin bee-alias launcher: every bin (pollen/waggle/buzz/forage/swarm/nectar/hive)
 * is the same unbrowse runtime with UNBROWSE_BEE_MODE=1.
 *
 * unbrowse's package.json `exports` only expose ./sdk/* — there is no "." or
 * "./package.json" export — so we locate the install by walking node_modules
 * (or PATH), never require.resolve("unbrowse/...").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aliasMeta, versionLine } from "./bee-brand.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);

const invoked = path.basename(process.argv[1] || "pollen", path.extname(process.argv[1] || ""));
const alias = (process.env.UNBROWSE_BEE_ALIAS || invoked).replace(/\.mjs$/, "");
const meta = aliasMeta(alias);

process.env.UNBROWSE_BEE_MODE = "1";
process.env.UNBROWSE_BEE_ALIAS = alias;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Walk up from start dirs looking for node_modules/unbrowse/package.json */
function findUnbrowseRoot() {
  const starts = [packageRoot, process.cwd(), here];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, "node_modules", "unbrowse", "package.json");
      if (existsSync(candidate)) return path.dirname(candidate);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function resolveUnbrowseLaunch() {
  const root = findUnbrowseRoot();
  if (root) {
    const wrapper = path.join(root, "bin", "unbrowse-wrapper.mjs");
    if (existsSync(wrapper)) {
      return { kind: "node", root, argv: [wrapper] };
    }
  }
  // Global / PATH install
  const which = spawnSync("sh", ["-c", "command -v unbrowse"], {
    encoding: "utf8",
    env: process.env,
  });
  const bin = (which.stdout || "").trim();
  if (which.status === 0 && bin) {
    return { kind: "bin", root: null, argv: [bin] };
  }
  return null;
}

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  const launch = resolveUnbrowseLaunch();
  const pollenPkg = readJson(path.join(packageRoot, "package.json"));
  let hiveVersion = pollenPkg?.version ?? "unknown";
  if (launch?.root) {
    const u = readJson(path.join(launch.root, "package.json"));
    if (u?.version) hiveVersion = u.version;
  }
  process.stdout.write(versionLine(hiveVersion, alias) + "\n");
  process.exit(0);
}

if ((args.includes("--help") || args.includes("-h")) && args.length <= 1) {
  process.stdout.write(
    [
      `${meta.emoji} ${alias} — bee-alias for unbrowse (${meta.tagline})`,
      "",
      "Same engine as `unbrowse`. Flat commands preferred:",
      "",
      `  ${alias} "task" --url <site>     one-call front door`,
      `  ${alias} get "task" --url <site>`,
      `  ${alias} setup`,
      `  ${alias} health`,
      `  ${alias} fetch <url>`,
      `  ${alias} resolve --intent "..." --url "..."`,
      `  ${alias} auth <login_url>`,
      "",
      "Install hive if missing:  npm i -g unbrowse@latest",
      "This package:             npm i -g @unbrowse/pollen-cli",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const launch = resolveUnbrowseLaunch();
if (!launch) {
  process.stderr.write(
    [
      `[${alias}] unbrowse runtime not found.`,
      "  Install the hive engine:  npm i -g unbrowse@latest",
      "  Then re-run:              npm i -g @unbrowse/pollen-cli",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

let result;
if (launch.kind === "node") {
  result = spawnSync(process.execPath, [...launch.argv, ...args], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  result = spawnSync(launch.argv[0], args, {
    stdio: "inherit",
    env: process.env,
  });
}
process.exit(result.status ?? 1);
