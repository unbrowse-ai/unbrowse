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
});
