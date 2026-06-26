/**
 * aiko-deploy — the aiko-native deploy primitive.
 *
 * `aikoDeploy()` wraps `recordDeploy()` with the current build info from
 * `build-info.generated.ts`, producing a witnessed deploy contract on the
 * four-tier stack (native libcontract → IQ on-chain → emergent KV → RAG).
 *
 * This is the "aiko deploys unbrowse" verb: the deployment IS a contract
 * transaction on the IQ substrate, not a side-effect decorated with a receipt.
 */
import { recordDeploy, type DeployManifest, type DeployRecord } from "./contract-deploy.js";
import {
  BUILD_RELEASE_VERSION,
  BUILD_GIT_SHA,
  BUILD_CODE_HASH,
} from "../build-info.generated.js";

export interface AikoDeployResult {
  deploy: DeployRecord;
  build: { release_version: string; git_sha: string; code_hash: string };
  witness: string;
}

/**
 * Deploy unbrowse as an aiko-native contract. Reads the current build info,
 * constructs a DeployManifest, and persists it across all four tiers.
 *
 * The `kind` defaults to "aiko-native" — distinguishing this from CI-driven
 * deploys ("cli", "server") so the deploy graph shows the aiko lineage.
 */
export async function aikoDeploy(opts: {
  kind?: string;
  target?: string;
  liveUrl?: string;
  witness?: string;
  artifactSha?: string;
} = {}): Promise<AikoDeployResult> {
  const manifest: DeployManifest = {
    kind: opts.kind ?? "aiko-native",
    release_version: BUILD_RELEASE_VERSION,
    git_sha: BUILD_GIT_SHA,
    artifact_sha: opts.artifactSha ?? BUILD_CODE_HASH,
    target: opts.target ?? `${process.platform}-${process.arch}`,
    live_url: opts.liveUrl,
    witness: opts.witness ?? "aiko-native-gate.sh",
    ts: Date.now(),
  };

  const deploy = await recordDeploy(manifest);

  return {
    deploy,
    build: {
      release_version: BUILD_RELEASE_VERSION,
      git_sha: BUILD_GIT_SHA,
      code_hash: BUILD_CODE_HASH,
    },
    witness: `deploy:${manifest.kind}:${manifest.release_version}:${manifest.git_sha.slice(0, 12)} → tiers: native=${deploy.persisted.native} iq=${deploy.persisted.iq} kv=${deploy.persisted.kv} rag=${deploy.persisted.rag}`,
  };
}
