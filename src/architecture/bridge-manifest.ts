/**
 * Bridge manifest for "Crypto Was All You Needed".
 *
 * The paper's stack node has one shape at every layer:
 * subject, verb, witness, parent. The public client must only see the
 * holes it can fill and the attestations it must provide; server-side
 * capture/reverse-engineering internals stay behind the bridge.
 */

import { knownCommands, surfaceFor, type Surface } from "./cli-surface.js";
import { AGENT_STANDARDS, type AgentStandard } from "../values/standards-registry.js";

export type PaperVerb = "observe" | "act" | "verify";
export type BridgeLayer = "screen" | "browser" | "cli" | "os" | "kernel" | "packet";
export type BridgeRole = "server" | "client" | "cli" | "aiko";
export type CanonicalCliVerb = "create" | "act" | "read";
export type CapabilityStatus = "ok" | "needs_input" | "payment_required" | "auth_required" | "unavailable" | "error";
export type CapabilitySource =
  | "native_route"
  | "installed_skill"
  | "mcp_tool"
  | "local_primitive"
  | "standard_adapter"
  | "marketplace_endpoint"
  | "browser_capture_fallback"
  | "indexer_contribution"
  | "unavailable";

export interface PaperNodeShape {
  readonly subject: string;
  readonly verb: PaperVerb;
  readonly witness: string;
  readonly parent: string;
}

export interface BridgeRoleSurface {
  readonly role: BridgeRole;
  readonly owns: readonly string[];
  readonly exposes: readonly string[];
  readonly hides: readonly string[];
}

export type BridgeHoleKind = "intent" | "auth" | "approval" | "capability" | "pointer";
export type BridgeHoleFill = "llm" | "wallet" | "human" | "local-dispatcher" | "server-pointer";

export interface BridgeHole {
  readonly name: string;
  readonly kind: BridgeHoleKind;
  readonly fill: BridgeHoleFill;
  readonly exposed_to: "client";
  readonly carries_secret: false;
}

export interface CapabilityResultContract {
  readonly name: "CapabilityResult";
  readonly minimum_fields: readonly string[];
  readonly optional_extensions: readonly string[];
  readonly statuses: readonly CapabilityStatus[];
  readonly sources: readonly CapabilitySource[];
  readonly invariant: "backward-compatible-minimum-shape";
}

export interface FallbackLevel {
  readonly rank: number;
  readonly source: CapabilitySource;
  readonly returns: "CapabilityResult";
  readonly fallback_on: readonly string[];
}

export interface LegacyAlias {
  readonly legacy: string;
  readonly canonical: `${CanonicalCliVerb} ${string}`;
  readonly reason: "backward-compatibility";
}

export interface IndexerContributionContract {
  readonly format: "capability-knowledge-row";
  readonly candidate_fields: readonly string[];
  readonly promotion_targets: readonly string[];
  readonly compiles_to: "CapabilityResult";
}

export interface RuntimeAuthorityContract {
  readonly local_substrate: "stateless_binary";
  readonly invocation: "unbrowse <verb> <capability> --json";
  readonly process_model: "single_shot";
  readonly durable_state: readonly string[];
  readonly compatibility_facades: readonly string[];
  readonly forbidden_authorities: readonly string[];
  readonly browser_primitives: {
    readonly owner: "binary_owned_lease";
    readonly module: "src/kuri/stateless-primitive.ts";
    readonly operations: readonly string[];
    readonly returns: "CapabilityResult";
    readonly lease_witness_fields: readonly string[];
  };
}

export interface BridgeManifest {
  readonly paper: "paper/crypto-was-all-you-needed.md";
  readonly claim: "one-node-layered-stack";
  readonly node_shape: PaperNodeShape;
  readonly layers: readonly BridgeLayer[];
  readonly cli_bridge: {
    readonly tool: "unbrowse contract surface";
    readonly exposes: "holes-only";
    readonly holes: readonly BridgeHole[];
    readonly canonical_verbs: readonly CanonicalCliVerb[];
    readonly commands: readonly Surface[];
    readonly legacy_aliases: readonly LegacyAlias[];
  };
  readonly compatibility: {
    readonly result_contract: CapabilityResultContract;
    readonly fallback_hierarchy: readonly FallbackLevel[];
    readonly standards: readonly AgentStandard[];
    readonly indexer_contribution: IndexerContributionContract;
  };
  readonly runtime_authority: RuntimeAuthorityContract;
  readonly roles: readonly BridgeRoleSurface[];
  readonly aiko_inverse: {
    readonly repo: "/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine";
    readonly mapping: "1:-1";
    readonly public_descriptor: "JSON descriptor plus rpc refs";
    readonly private_runtime: "live plugin functions stay in worker registry";
  };
}

const PAPER_NODE_SHAPE: PaperNodeShape = {
  subject: "who/what/when/where/why/how action descriptor",
  verb: "act",
  witness: "settled/not-settled check with independent corroboration",
  parent: "content hash of the node one layer up",
};

const LAYERS: readonly BridgeLayer[] = ["screen", "browser", "cli", "os", "kernel", "packet"];
const CANONICAL_VERBS: readonly CanonicalCliVerb[] = ["create", "act", "read"];

const BRIDGE_HOLES: readonly BridgeHole[] = [
  {
    name: "intent",
    kind: "intent",
    fill: "llm",
    exposed_to: "client",
    carries_secret: false,
  },
  {
    name: "wallet_proof",
    kind: "auth",
    fill: "wallet",
    exposed_to: "client",
    carries_secret: false,
  },
  {
    name: "approval",
    kind: "approval",
    fill: "human",
    exposed_to: "client",
    carries_secret: false,
  },
  {
    name: "local_capability_result",
    kind: "capability",
    fill: "local-dispatcher",
    exposed_to: "client",
    carries_secret: false,
  },
  {
    name: "typed_pointer",
    kind: "pointer",
    fill: "server-pointer",
    exposed_to: "client",
    carries_secret: false,
  },
];

const RESULT_CONTRACT: CapabilityResultContract = {
  name: "CapabilityResult",
  minimum_fields: ["status", "kind", "source", "data", "requirements", "artifacts", "evidence", "next_action"],
  optional_extensions: ["view_spec", "trace_ref", "payment", "lineage", "confidence", "warnings", "compatibility"],
  statuses: ["ok", "needs_input", "payment_required", "auth_required", "unavailable", "error"],
  sources: [
    "native_route",
    "installed_skill",
    "mcp_tool",
    "local_primitive",
    "standard_adapter",
    "marketplace_endpoint",
    "browser_capture_fallback",
    "indexer_contribution",
    "unavailable",
  ],
  invariant: "backward-compatible-minimum-shape",
};

const FALLBACK_HIERARCHY: readonly FallbackLevel[] = [
  { rank: 1, source: "native_route", returns: "CapabilityResult", fallback_on: ["miss", "stale", "auth_required"] },
  { rank: 2, source: "installed_skill", returns: "CapabilityResult", fallback_on: ["missing_skill", "schema_incompatible"] },
  { rank: 3, source: "mcp_tool", returns: "CapabilityResult", fallback_on: ["tool_missing", "tool_unavailable"] },
  { rank: 4, source: "local_primitive", returns: "CapabilityResult", fallback_on: ["capability_unavailable"] },
  { rank: 5, source: "standard_adapter", returns: "CapabilityResult", fallback_on: ["registry_miss", "adapter_error"] },
  { rank: 6, source: "marketplace_endpoint", returns: "CapabilityResult", fallback_on: ["payment_required", "no_match"] },
  { rank: 7, source: "indexer_contribution", returns: "CapabilityResult", fallback_on: ["not_promoted", "needs_verification"] },
  { rank: 8, source: "browser_capture_fallback", returns: "CapabilityResult", fallback_on: ["capture_failed", "manual_interaction_required"] },
  { rank: 9, source: "unavailable", returns: "CapabilityResult", fallback_on: [] },
];

const LEGACY_ALIASES: readonly LegacyAlias[] = [
  { legacy: "resolve", canonical: "read resolve", reason: "backward-compatibility" },
  { legacy: "search", canonical: "read resolve", reason: "backward-compatibility" },
  { legacy: "skills", canonical: "read skills", reason: "backward-compatibility" },
  { legacy: "skill", canonical: "read skill", reason: "backward-compatibility" },
  { legacy: "snap", canonical: "read snap", reason: "backward-compatibility" },
  { legacy: "text", canonical: "read text", reason: "backward-compatibility" },
  { legacy: "execute", canonical: "act execute", reason: "backward-compatibility" },
  { legacy: "go", canonical: "act go", reason: "backward-compatibility" },
  { legacy: "click", canonical: "act click", reason: "backward-compatibility" },
  { legacy: "fill", canonical: "act fill", reason: "backward-compatibility" },
  { legacy: "submit", canonical: "act submit", reason: "backward-compatibility" },
  { legacy: "publish", canonical: "create publish", reason: "backward-compatibility" },
  { legacy: "index", canonical: "create index", reason: "backward-compatibility" },
];

const INDEXER_CONTRIBUTION: IndexerContributionContract = {
  format: "capability-knowledge-row",
  candidate_fields: ["kind", "target", "recipe", "schema_hint", "auth_note", "failure_pattern", "evidence", "savings", "redactions"],
  promotion_targets: ["executable_endpoint", "discovery_backend", "avoid_path_policy", "verifier_fixture", "skill_instruction", "docs_projection"],
  compiles_to: "CapabilityResult",
};

const RUNTIME_AUTHORITY: RuntimeAuthorityContract = {
  local_substrate: "stateless_binary",
  invocation: "unbrowse <verb> <capability> --json",
  process_model: "single_shot",
  durable_state: [
    "route_graph",
    "content_addressed_cache",
    "ledger_rows",
    "credential_vault",
    "browser_profile_authority",
  ],
  compatibility_facades: [
    "unbrowse serve",
    "stdio_mcp_server",
    "http_contract_surface",
    "sdk_client",
  ],
  forbidden_authorities: [
    "long_lived_local_unbrowse_server",
    "shared_kuri_tab_registry",
    "kuri_broker_http_api",
    "background_browser_worker_without_lease",
  ],
  browser_primitives: {
    owner: "binary_owned_lease",
    module: "src/kuri/stateless-primitive.ts",
    operations: [
      "direct_cdp.spawn_chrome",
      "direct_cdp.create_target",
      "direct_cdp.navigate",
      "direct_cdp.capture_network",
      "direct_cdp.read_dom",
      "direct_cdp.solve_or_report_interstitial",
      "direct_cdp.release",
    ],
    returns: "CapabilityResult",
    lease_witness_fields: ["lease_id", "op", "url", "acquired_at", "released_at", "helper_pid"],
  },
};

function publicCommandSurfaces(): Surface[] {
  return knownCommands()
    .map((command) => surfaceFor(command))
    .filter((surface): surface is Surface => surface !== null)
    .sort((a, b) => a.command.localeCompare(b.command));
}

export function bridgeManifest(): BridgeManifest {
  return {
    paper: "paper/crypto-was-all-you-needed.md",
    claim: "one-node-layered-stack",
    node_shape: PAPER_NODE_SHAPE,
    layers: LAYERS,
    cli_bridge: {
      tool: "unbrowse contract surface",
      exposes: "holes-only",
      holes: BRIDGE_HOLES,
      canonical_verbs: CANONICAL_VERBS,
      commands: publicCommandSurfaces(),
      legacy_aliases: LEGACY_ALIASES,
    },
    compatibility: {
      result_contract: RESULT_CONTRACT,
      fallback_hierarchy: FALLBACK_HIERARCHY,
      standards: AGENT_STANDARDS,
      indexer_contribution: INDEXER_CONTRIBUTION,
    },
    runtime_authority: RUNTIME_AUTHORITY,
    roles: [
      {
        role: "server",
        owns: ["route graph", "capture/reverse-engineering engine", "ranking", "ledger", "settlement"],
        exposes: ["skeleton", "holes", "attestation verdict", "pointer ids"],
        hides: ["secret values", "engine internals", "economic constants", "private keys"],
      },
      {
        role: "client",
        owns: ["wallet", "vault fills", "browser/session state", "local capability dispatcher"],
        exposes: ["hole fills", "wallet-bound proofs", "local capability results"],
        hides: ["raw secrets", "private wallet material"],
      },
      {
        role: "cli",
        owns: ["stdio/argv bridge", "local capability invocation", "machine-readable surface projection"],
        exposes: ["contract surface manifest", "command holes", "dispatch results"],
        hides: ["server decision trace", "capture internals"],
      },
      {
        role: "aiko",
        owns: ["agent planning", "worker handler registry", "runtime-private functions"],
        exposes: ["JSON plugin descriptor", "rpc refs", "agent-callable tool affordances"],
        hides: ["live function bodies", "runtime process state"],
      },
    ],
    aiko_inverse: {
      repo: "/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine",
      mapping: "1:-1",
      public_descriptor: "JSON descriptor plus rpc refs",
      private_runtime: "live plugin functions stay in worker registry",
    },
  };
}
