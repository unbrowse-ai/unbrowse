#!/usr/bin/env node

import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(packageRoot, "dist");
const runtimeSourceDir = path.join(packageRoot, "runtime-src");
const fallbackLauncher = path.join(packageRoot, "bin", "unbrowse.js");
const wrapper = path.join(packageRoot, "bin", "unbrowse-wrapper.mjs");

rmSync(distDir, { recursive: true, force: true });
rmSync(runtimeSourceDir, { recursive: true, force: true });
rmSync(fallbackLauncher, { force: true });
chmodSync(wrapper, 0o755);
