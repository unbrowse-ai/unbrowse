/**
 * contract-deploy — a deploy is itself a /contract on the crypto-was-all-you-needed stack.
 *
 * The build-attest ledger (build-attest.ts, PR #875) already wallet-SIGNS each artifact
 * (kind / version / git_sha / artifact_sha / parent_sha). This module takes that deploy
 * EVENT and records it as a first-class /contract through the unification seam
 * (contract-everything.ts), so every deploy is:
 *   - stored on IQ            → on-chain, append-only, wallet-signed deploy history
 *   - cached by emergent      → O(1) recall of "what is live" by deploy id
 *   - searchable by emergent  → semantic search ("when did we last ship the server?")
 *
 * It does NOT re-implement signing or persistence — it composes persistContract. The
 * deploy is the WHAT (a manifest); the stack is the HOW (IQ + emergent), already built.
 */

import {
  persistContract,
  recallContract,
  searchContractsEverywhere,
  type ContractEverything,
} from "./contract-everything.js";
import type { ScoredId } from "./contract-search.js";

/** What is being deployed and where. Mirrors build-attest's AttestBody fields so a
 *  deploy contract and its signed build attestation describe the same artifact. */
export interface DeployManifest {
  /** cli | server | frontend | npm | binary — the deploy target class. */
  kind: string;
  /** semver of the release being deployed. */
  release_version: string;
  /** git commit the deploy was cut from. */
  git_sha: string;
  /** sha256 of the deployed artifact bytes (from build-attest), when known. */
  artifact_sha?: string;
  /** concrete target (platform triple, worker env, prod URL host, npm tag). */
  target: string;
  /** the live URL this deploy serves, when applicable. */
  live_url?: string;
  /** the witness command/verdict that gated the deploy (honest provenance). */
  witness?: string;
  /** unix ms; caller stamps it (kept explicit so the id is reproducible). */
  ts: number;
}

const DEPLOY_NAMESPACE = "ubz-deploys";

/** Stable, reproducible deploy contract id — same (kind, version, git_sha, ts) → same id. */
export function deployContractId(m: DeployManifest): string {
  return `deploy:${m.kind}:${m.release_version}:${m.git_sha.slice(0, 12)}:${m.ts}`;
}

/** The human description the RAG layer embeds — what makes a deploy semantically findable. */
export function deployText(m: DeployManifest): string {
  const parts = [
    `deploy ${m.kind} ${m.release_version}`,
    `git ${m.git_sha.slice(0, 12)}`,
    `target ${m.target}`,
    m.live_url ? `live ${m.live_url}` : "",
    m.artifact_sha ? `artifact ${m.artifact_sha.slice(0, 12)}` : "",
  ].filter(Boolean);
  return parts.join(" — ");
}

export interface DeployRecord {
  id: string;
  manifest: DeployManifest;
  /** which stack tiers the deploy landed on (iq / kv / rag), with notes. */
  persisted: Awaited<ReturnType<typeof persistContract>>;
}

/**
 * Record a deploy as a /contract on the full stack. Composes persistContract:
 * the deploy manifest becomes an on-chain IQ row + emergent KV cache entry +
 * emergent RAG-indexed document. Fail-open per tier (a tier with absent creds is a
 * surfaced note, not a throw), so a deploy is never blocked by the recorder.
 */
export async function recordDeploy(m: DeployManifest): Promise<DeployRecord> {
  const id = deployContractId(m);
  const contract: ContractEverything = { id, text: deployText(m), value: m };
  const persisted = await persistContract(contract, { namespace: DEPLOY_NAMESPACE });
  return { id, manifest: m, persisted };
}

/** Recall a deploy manifest by id — emergent KV fast tier, IQ durable behind. */
export async function recallDeploy(id: string): Promise<DeployManifest | null> {
  const v = await recallContract(id, { namespace: DEPLOY_NAMESPACE });
  return (v ?? null) as DeployManifest | null;
}

/** Semantic search across recorded deploys (e.g. "server deploy" / a version / a host). */
export async function searchDeploys(query: string, k = 5): Promise<ScoredId[]> {
  return searchContractsEverywhere(query, { namespace: DEPLOY_NAMESPACE, k });
}
