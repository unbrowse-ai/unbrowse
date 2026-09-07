#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBanner } from "../lib/bee-brand.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let version = "unknown";
try {
  version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version ?? version;
} catch {
  /* best-effort */
}

if (process.env.UNBROWSE_BEE_QUIET === "1") {
  process.exit(0);
}

process.stderr.write(installBanner(version));