#!/usr/bin/env bun
/**
 * contract-deploy-record — the NEW /contract-deploy surface: record a deploy as a
 * /contract on the crypto-was-all-you-needed stack (IQ + emergent cache + emergent RAG).
 *
 * Run AFTER a deploy lands (npm publish / wrangler deploy / binary swap):
 *   bun scripts/contract-deploy-record.ts --kind server --target beta-api.unbrowse.ai \
 *       [--version <semver>] [--git <sha>] [--artifact-sha <hex>] [--live-url <url>] \
 *       [--witness "<cmd>"]
 *
 * Defaults: version ← package.json, git ← `git rev-parse HEAD`, ts ← now. The deploy
 * manifest becomes an on-chain IQ row + emergent KV entry + RAG-indexed document, so
 * `searchDeploys("server deploy …")` can later answer "what is live, and when did it ship".
 * Fail-open: a tier with absent creds is a surfaced note, never a thrown deploy-blocker.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordDeploy, type DeployManifest } from "../src/values/contract-deploy.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const manifest: DeployManifest = {
  kind: arg("kind") ?? "cli",
  release_version: arg("version") ?? pkgVersion(),
  git_sha: arg("git") ?? gitSha(),
  artifact_sha: arg("artifact-sha"),
  target: arg("target") ?? "unspecified",
  live_url: arg("live-url"),
  witness: arg("witness"),
  ts: Date.now(),
};

const rec = await recordDeploy(manifest);
const tiers = ["iq", "kv", "rag"].filter((t) => (rec.persisted as Record<string, unknown>)[t]).join("+") || "none";
process.stdout.write(
  JSON.stringify({ ok: tiers !== "none", deploy_id: rec.id, tiers, notes: rec.persisted.notes, manifest }, null, 2) + "\n",
);
// Non-zero only when NOTHING landed (every tier unconfigured/failed) — so CI can tell a
// real recording from a total no-op, while a partial (e.g. IQ-only) deploy record still passes.
process.exit(tiers === "none" ? 1 : 0);
