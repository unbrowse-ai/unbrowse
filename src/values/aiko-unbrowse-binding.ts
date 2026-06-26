/**
 * Native Aiko -> Unbrowse binding.
 *
 * This is deliberately a manifest, not a vendored copy of aiko-engine3. Aiko is
 * the parent agent/runtime; Unbrowse is the child internet executor. The bridge
 * is pointer-only: it names the repo, command surface, on-chain receipt lanes,
 * and funding lane that already exist in Unbrowse.
 */

export const AIKO_ENGINE3_REPO = "/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine3" as const;

export interface AikoUnbrowseBinding {
  readonly parent: {
    readonly name: "aiko";
    readonly engine_repo: typeof AIKO_ENGINE3_REPO;
    readonly runtime_protocol: "aiko --json";
  };
  readonly child: {
    readonly name: "unbrowse";
    readonly authority: "stateless_binary";
    readonly commands: readonly ["resolve", "execute", "search", "account.sponsorStatus"];
  };
  readonly on_chain_access: {
    readonly route_index: "cachedResolution -> mirrorResolutionToChain -> IQ Solana table";
    readonly sealed_values: "iqseal:<txSig> via iq-sealed-value";
    readonly deploys: "recordDeploy -> persistContract(namespace=ubz-deploys)";
  };
  readonly economy: {
    readonly new_client_seed: "sponsor-status/credit budget funds first indexing work";
    readonly contributor_loop: "capture -> route pointer -> replay -> payout attribution";
  };
  readonly invariants: readonly string[];
}

export function aikoUnbrowseBinding(): AikoUnbrowseBinding {
  return {
    parent: {
      name: "aiko",
      engine_repo: AIKO_ENGINE3_REPO,
      runtime_protocol: "aiko --json",
    },
    child: {
      name: "unbrowse",
      authority: "stateless_binary",
      commands: ["resolve", "execute", "search", "account.sponsorStatus"],
    },
    on_chain_access: {
      route_index: "cachedResolution -> mirrorResolutionToChain -> IQ Solana table",
      sealed_values: "iqseal:<txSig> via iq-sealed-value",
      deploys: "recordDeploy -> persistContract(namespace=ubz-deploys)",
    },
    economy: {
      new_client_seed: "sponsor-status/credit budget funds first indexing work",
      contributor_loop: "capture -> route pointer -> replay -> payout attribution",
    },
    invariants: [
      "Aiko never receives raw secrets from Unbrowse; it receives typed pointers and wallet proofs.",
      "Unbrowse never signs parent Aiko truth claims; it signs only web execution capabilities.",
      "Fresh indexed routes mirror to the IQ ledger when chain env is configured and fail open to local cache otherwise.",
      "Deploys and sealed values are accessible by pointer, not by inlined payload.",
    ],
  };
}
