#!/usr/bin/env node
const { execFileSync } = require("child_process");
const path = require("path");
const BIN = path.join(__dirname, "kuri-agent-bin");
try {
  execFileSync(BIN, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
