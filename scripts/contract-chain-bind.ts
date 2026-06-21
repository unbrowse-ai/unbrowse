#!/usr/bin/env bun
/**
 * contract-chain-bind — record the source-of-truth chain (papers → code → cli → frontend) as
 * ONE /contract on the stack, and the chain itself as a deploy contract. Called by
 * scripts/contract-chain-gate.sh AFTER it has run the per-link reflection witnesses, so the
 * reflect booleans are real (the gate decides green, this records the verdict).
 *
 *   bun scripts/contract-chain-bind.ts --links t,t,t [--target "unbrowse(cli+server+frontend)"]
 *
 * --links is a comma-separated boolean per link, in chainLinkSpecs() order (papers>code,
 * code>cli, cli>frontend). Fail-open per stack tier (absent creds = a surfaced note).
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { bindChain, recordChain, chainLinkSpecs, type ChainLink } from "../src/values/contract-chain.js";
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

const truthy = (s: string) => /^(t|true|1|ok|green|yes)$/i.test(s.trim());
const flags = (arg("links") ?? "").split(",").filter(Boolean).map(truthy);
const specs = chainLinkSpecs();
const links: ChainLink[] = specs.map((s, i) => ({ ...s, reflects: flags[i] ?? false }));

const ts = Date.now();
const binding = bindChain(links, { ts });
const chain = await recordChain(binding);

// The chain is itself a deploy: cli+server+frontend bound to one source of truth.
const deploy: DeployManifest = {
  kind: "chain",
  release_version: chain.id,
  git_sha: gitSha(),
  target: arg("target") ?? "unbrowse(cli+server+frontend)",
  witness: "scripts/contract-chain-gate.sh",
  ts,
};
const dep = await recordDeploy(deploy);

const tiers = (p: { iq: boolean; kv: boolean; rag: boolean }) =>
  ["iq", "kv", "rag"].filter((t) => (p as Record<string, unknown>)[t]).join("+") || "none";

process.stdout.write(
  JSON.stringify(
    {
      bound: binding.bound,
      chain_id: chain.id,
      taste: { verdict: binding.taste.verdict, overall: binding.taste.overall },
      links: links.map((l) => `${l.from}${l.reflects ? "→" : "⊘"}${l.to}`),
      chain_tiers: tiers(chain.persisted),
      deploy_id: dep.id,
      deploy_tiers: tiers(dep.persisted),
      notes: [...chain.persisted.notes, ...dep.persisted.notes],
    },
    null,
    2,
  ) + "\n",
);
// The reflection is gated by the witnesses upstream; here non-zero only if the chain is unbound.
process.exit(binding.bound ? 0 : 1);
