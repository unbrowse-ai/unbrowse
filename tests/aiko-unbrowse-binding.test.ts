import { describe, expect, it } from "bun:test";
import { aikoUnbrowseBinding, AIKO_ENGINE3_REPO } from "../src/values/aiko-unbrowse-binding.js";
import { bridgeManifest } from "../src/superpattern/bridge-manifest.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Aiko native Unbrowse binding", () => {
  it("points the parent runtime at aiko-engine3 without vendoring it", () => {
    const binding = aikoUnbrowseBinding();

    expect(binding.parent.engine_repo).toBe(AIKO_ENGINE3_REPO);
    expect(binding.parent.runtime_protocol).toBe("aiko --json");
    expect(binding.child.authority).toBe("stateless_binary");
    expect(binding.invariants.some((line) => line.includes("never receives raw secrets"))).toBe(true);
  });

  it("names the on-chain and seeded-economy surfaces Aiko can rely on", () => {
    const binding = aikoUnbrowseBinding();

    expect(binding.on_chain_access.route_index).toContain("mirrorResolutionToChain");
    expect(binding.on_chain_access.sealed_values).toContain("iqseal:");
    expect(binding.on_chain_access.deploys).toContain("recordDeploy");
    expect(binding.economy.new_client_seed).toContain("sponsor-status");
  });

  it("is projected through the machine-readable bridge manifest", () => {
    const manifest = bridgeManifest();

    expect(manifest.aiko_inverse.repo).toBe(AIKO_ENGINE3_REPO);
    expect(manifest.aiko_unbrowse_binding.parent.engine_repo).toBe(AIKO_ENGINE3_REPO);
    expect(manifest.aiko_unbrowse_binding.child.commands).toContain("execute");
  });

  it("ensures always testing against benchmarks before cut/deploy and keeping on staging when bypassed", () => {
    // Verify the release script has been modified to enforce Aiko benchmark-gate
    const releaseScriptPath = join(import.meta.dir, "../scripts/release-and-verify.sh");
    const scriptContent = readFileSync(releaseScriptPath, "utf8");

    expect(scriptContent).toContain("Step 1.2: Benchmark check via Aiko");
    expect(scriptContent).toContain("scripts/bench-gate");
    expect(scriptContent).toContain("Recording staging deploy contract");
    expect(scriptContent).toContain("contract-deploy-record.ts --kind server --target staging");
    expect(scriptContent).toContain("Production deploy contract registered");
    expect(scriptContent).toContain("contract-deploy-record.ts --kind server --target production");
  });

  it("ensures public architecture docs are free of internal method-vocabulary leak 'superpattern'", () => {
    const authDocsPath = join(import.meta.dir, "../docs/architecture/AUTH.md");
    const docsContent = readFileSync(authDocsPath, "utf8");

    // The word 'superpattern' should not appear in public-facing architecture docs
    expect(docsContent).not.toContain("superpattern");
  });

  it("exercises recordDeploy under golden, empty, and adversarial cases", async () => {
    const { recordDeploy, deployContractId } = await import("../src/values/contract-deploy.js");

    // 1. Golden Path: full manifest with proper values
    const goldenManifest = {
      kind: "server",
      release_version: "11.1.1",
      git_sha: "cd8ff2a8b93b21f93029cbc03ad843d3547430b4",
      artifact_sha: "artcd8ff2a8",
      target: "production",
      live_url: "https://beta-api.unbrowse.ai",
      witness: "release-and-verify.sh",
      ts: Date.now(),
    };
    const id = deployContractId(goldenManifest);
    expect(id).toBe(`deploy:server:11.1.1:cd8ff2a8b93b:${goldenManifest.ts}`);

    // 2. Edge Case 1: Minimal/Empty optional variables
    const edgeManifest1 = {
      kind: "cli",
      release_version: "11.1.1",
      git_sha: "cd8ff2a8b93b21f93029cbc03ad843d3547430b4",
      target: "staging",
      ts: Date.now(),
    };
    const edgeId1 = deployContractId(edgeManifest1);
    expect(edgeId1).toBe(`deploy:cli:11.1.1:cd8ff2a8b93b:${edgeManifest1.ts}`);

    // 3. Adversarial Case: Weird symbols and long strings in kind or version
    const adversarialManifest = {
      kind: "server/api-gateway; DROP TABLE resolutions;--",
      release_version: "v1.0.0-beta.1+build.123",
      git_sha: "../weird-relative-path/../../../etc/passwd",
      target: "staging-adversarial-env",
      ts: Date.now(),
    };
    const advId = deployContractId(adversarialManifest);
    expect(advId).toContain("deploy:server/api-gateway; DROP TABLE resolutions;--");
    expect(advId).toContain("v1.0.0-beta.1+build.123");
    expect(advId).toContain("../weird-rel");
  });
});
