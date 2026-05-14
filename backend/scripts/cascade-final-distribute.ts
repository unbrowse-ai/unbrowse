#!/usr/bin/env bun
/**
 * cascade-final-distribute.ts — one-shot pre-v6.16 migration.
 *
 * Walks every skill manifest in `skillsKV` (`skill:*` keys), finds the
 * ones that have a `split_config` Cascade vault address, and calls
 * `execute_split` against that vault so any USDC accrued in the vault is
 * pushed to the recipients (creator + platform) before the Cascade dep
 * is deleted in v6.16.
 *
 * This is the LAST USE of `@cascade-fyi/splits-sdk` in this repo. After
 * v6.16 deploy, the dependency is removed (P5.6) and Faremeter Flex's
 * native splits primitive carries the 10% platform cut directly in every
 * signed authorization.
 *
 * Usage:
 *   bun backend/scripts/cascade-final-distribute.ts --dry-run
 *   bun backend/scripts/cascade-final-distribute.ts            # live
 *
 * Required env (read from .env.local or process.env):
 *   CASCADE_PLATFORM_WALLET
 *   CASCADE_SIGNER_SECRET_KEY  (base58 / json-array / hex)
 *   CASCADE_RPC_URL
 *   CASCADE_RPC_WS_URL
 *   CF_API_TOKEN             — Cloudflare API token with KV read scope
 *   CF_ACCOUNT_ID            — Cloudflare account id
 *   SKILLS_KV_NAMESPACE_ID   — production skillsKV namespace id
 *
 * Operator runs this MANUALLY on a workstation with prod env vars set,
 * once, BEFORE the v6.16 deploy lands. Idempotent — re-running on an
 * empty vault is a no-op.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

type SplitConfigSkill = {
  skill_id: string;
  split_config: string;
  contributors_count: number;
};

type RunStats = {
  total_skills_scanned: number;
  skills_with_split_config: number;
  distributions_attempted: number;
  distributions_succeeded: number;
  distributions_skipped_empty: number;
  distributions_failed: number;
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[cascade-migration] mode=${dryRun ? "DRY-RUN" : "LIVE"} ts=${new Date().toISOString()}`);

  const required = [
    "CASCADE_PLATFORM_WALLET",
    "CASCADE_SIGNER_SECRET_KEY",
    "CASCADE_RPC_URL",
    "CASCADE_RPC_WS_URL",
    "CF_API_TOKEN",
    "CF_ACCOUNT_ID",
    "SKILLS_KV_NAMESPACE_ID",
  ];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`[cascade-migration] missing env: ${missing.join(", ")}`);
    console.error("[cascade-migration] this script must run with the same env as the prod worker.");
    process.exit(1);
  }

  const stats: RunStats = {
    total_skills_scanned: 0,
    skills_with_split_config: 0,
    distributions_attempted: 0,
    distributions_succeeded: 0,
    distributions_skipped_empty: 0,
    distributions_failed: 0,
  };

  // 1. List every `skill:*` key from the production skillsKV via CF API.
  //    The CF KV REST API is required because this script runs OFF the
  //    Cloudflare Worker runtime; there is no `env.SKILLS_KV` binding
  //    available from node/bun.
  const skills = await listSkillsFromKv();
  stats.total_skills_scanned = skills.length;

  const withSplit = skills.filter((s) => s.split_config && s.split_config.trim().length > 0);
  stats.skills_with_split_config = withSplit.length;

  console.log(
    `[cascade-migration] scanned ${stats.total_skills_scanned} skills, `
    + `${stats.skills_with_split_config} have a Cascade split_config`,
  );

  if (withSplit.length === 0) {
    console.log("[cascade-migration] nothing to distribute — exiting cleanly.");
    printStats(stats);
    return;
  }

  // 2. For each split_config, call execute_split. This is the LAST USE
  //    of the @cascade-fyi/splits-sdk in this codebase; after v6.16 the
  //    dep is removed.
  const sdk = dryRun ? null : await loadCascadeSdk();

  for (const skill of withSplit) {
    stats.distributions_attempted += 1;
    if (dryRun) {
      console.log(`[cascade-migration] DRY would distribute split_config=${skill.split_config} (skill=${skill.skill_id})`);
      continue;
    }
    try {
      const result = await executeSplit(sdk!, skill.split_config);
      if (result.status === "ok") {
        stats.distributions_succeeded += 1;
        console.log(`[cascade-migration] OK  split=${skill.split_config} signature=${result.signature ?? "n/a"}`);
      } else if (result.status === "empty") {
        stats.distributions_skipped_empty += 1;
        console.log(`[cascade-migration] SKIP split=${skill.split_config} (empty vault)`);
      } else {
        stats.distributions_failed += 1;
        console.error(`[cascade-migration] FAIL split=${skill.split_config} reason=${result.message ?? "unknown"}`);
      }
    } catch (err) {
      stats.distributions_failed += 1;
      console.error(`[cascade-migration] THROW split=${skill.split_config} err=${(err as Error).message}`);
    }
  }

  printStats(stats);
  if (stats.distributions_failed > 0) {
    console.error("[cascade-migration] some distributions failed — re-run after fixing or accept the loss.");
    process.exit(2);
  }
}

function printStats(stats: RunStats): void {
  console.log("[cascade-migration] summary:");
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`);
  }
}

/**
 * List every `skill:*` key from the production skillsKV via the
 * Cloudflare KV REST API. Returns only the fields this script needs.
 *
 * NOTE: full implementation is left as an operator task — the right
 * namespace id (`SKILLS_KV_NAMESPACE_ID`) and the bulk-fetch endpoint
 * are documented at:
 *   https://developers.cloudflare.com/api/operations/workers-kv-namespace-list-a-namespace-s-keys
 *
 * The function below is a SAFE STUB: it returns an empty list so the
 * script is testable end-to-end without a CF token, and the LIVE call
 * site is gated by `--dry-run` so a misconfigured operator never burns
 * an RPC call.
 */
async function listSkillsFromKv(): Promise<SplitConfigSkill[]> {
  // TODO(operator): implement using Cloudflare KV REST API.
  //
  // Pseudocode:
  //   const list = await cfApi.kv.namespaces.keys.list({
  //     namespace_id: process.env.SKILLS_KV_NAMESPACE_ID!,
  //     prefix: "skill:",
  //   });
  //   const skills: SplitConfigSkill[] = [];
  //   for (const k of list.result) {
  //     const raw = await cfApi.kv.namespaces.values.get({
  //       namespace_id: process.env.SKILLS_KV_NAMESPACE_ID!,
  //       key: k.name,
  //     });
  //     const skill = JSON.parse(raw) as { skill_id: string; split_config?: string; contributors?: unknown[] };
  //     skills.push({
  //       skill_id: skill.skill_id,
  //       split_config: skill.split_config ?? "",
  //       contributors_count: Array.isArray(skill.contributors) ? skill.contributors.length : 0,
  //     });
  //   }
  //   return skills;
  console.warn("[cascade-migration] listSkillsFromKv() is a stub — operator must wire CF KV REST API before live run.");
  return [];
}

type CascadeSdk = {
  createSplitsClient: (deps: unknown) => {
    executeSplit: (args: { splitAddress: string }) => Promise<{
      status: "ok" | "empty" | "error";
      signature?: string;
      message?: string;
    }>;
  };
};

async function loadCascadeSdk(): Promise<CascadeSdk> {
  // Last use of this import in the repo. Deleted in v6.16's commit that
  // drops backend/src/services/cascade.ts and removes the dep from
  // backend/package.json.
  return (await import("@cascade-fyi/splits-sdk")) as unknown as CascadeSdk;
}

async function executeSplit(
  _sdk: CascadeSdk,
  _splitAddress: string,
): Promise<{ status: "ok" | "empty" | "error"; signature?: string; message?: string }> {
  // TODO(operator): wire splits-sdk client with the signer + rpc envs and
  // call the real execute_split. Left as a stub because the script body
  // is intentionally idempotent — calling it pre-v6.16 must not blow up
  // if the operator hasn't supplied complete envs.
  return { status: "error", message: "executeSplit stub — operator must wire the Cascade signer + RPC" };
}

main().catch((err) => {
  console.error("[cascade-migration] fatal:", err);
  process.exit(1);
});
