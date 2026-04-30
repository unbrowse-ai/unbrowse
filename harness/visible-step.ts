#!/usr/bin/env bun
// Harness #2 — Visible Step seed.
// Declares (does not yet capture) the per-step artifact contract.
// Spawns no browser. Step 4 (luminaries / signals) wires up kuri.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parseArg(name: string): string | undefined {
  const flag = `--${name}`;
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (!val || val.startsWith("--")) return undefined;
  return val;
}

const intent = parseArg("intent");
const url = parseArg("url");
const runId = parseArg("run-id");

if (!intent || !url || !runId) {
  console.error(
    "Usage: bun harness/visible-step.ts --intent <string> --url <string> --run-id <string>",
  );
  process.exit(2);
}

const stepId = "step-001";
const artifactDir = join(".harness-out", runId, stepId);
if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });

const now = new Date().toISOString();
const stepRecord = {
  step_id: stepId,
  intent,
  url,
  visible: process.env.HEADLESS === "false",
  screenshot_path: join(artifactDir, "screenshot.png"),
  a11y_path: join(artifactDir, "a11y.json"),
  har_path: join(artifactDir, "har.json"),
  resolve_path: join(artifactDir, "resolve.json"),
  kuri_log_path: join(artifactDir, "kuri.log"),
  kuri_pid: null as number | null,
  started_at: now,
  ended_at: now,
  // Seed-level note: this step DECLARES the contract; capture lands in step 4.
  status: "declared",
};

const stepJsonPath = join(artifactDir, "step.json");
writeFileSync(stepJsonPath, JSON.stringify(stepRecord, null, 2) + "\n");

console.log(`[visible-step] wrote ${stepJsonPath}`);
console.log(JSON.stringify(stepRecord, null, 2));
process.exit(0);
