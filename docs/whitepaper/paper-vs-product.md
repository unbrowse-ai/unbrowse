# Paper vs Product Status

This page maps the whitepaper to the actual codebase.

Status meanings:

- `Shipped`: present in the codebase today
- `Partial`: some implementation exists, but not in the full form described in the paper
- `Coming soon`: described in the paper, but not present in the current codebase

## Capability Layer

| Paper claim | Status | Notes |
| --- | --- | --- |
| Shared marketplace of discovered skills | Shipped | Marketplace publish, fetch, search, ranking, and reuse are implemented. |
| Local cache plus shared graph plus browser fallback | Shipped | Practical three-path behavior exists through route cache, marketplace search, and live capture fallback. |
| Passive indexing from normal use | Shipped | Capture, learn, and passive publish flow exists. |
| Intent resolution with composite scoring | Shipped | Current ranking uses embedding similarity, reliability, freshness, and verification weighting. |
| Schema drift detection | Shipped | Drift detection and verification-aware scoring exist. |
| Skill lifecycle: active, deprecated, disabled | Shipped | Skill and endpoint lifecycle states exist in code. |
| Periodic safe-endpoint re-verification | Shipped | Verification loop exists for safe GET endpoints. |
| Local encrypted credential vault | Shipped | Local vault exists with keychain plus encrypted-file fallback. |
| MCP support | Shipped | `unbrowse mcp` is implemented. |
| Broad agent-host integration surface | Shipped | Installer, CLI, MCP, skill flows, and host-specific integrations exist. |
| Route dependency graph and graph-backed planning | Partial | Graph primitives and operation graph data structures exist, but this is not yet the dominant product surface described in the paper. |
| Per-skill package containing `SKILL.md`, `auth.json`, and generated `api.ts` | Coming soon | The marketplace distributes skill manifests and auth references today, not full installable route bundles in the paper’s format. |
| A2A / ANP style protocol coverage | Coming soon | Mentioned in the paper context, not implemented in this codebase. |

## Economic Layer

| Paper claim | Status | Notes |
| --- | --- | --- |
| Economic adoption condition `froute < c_rediscovery` | Partial | The paper’s framing is documented, but the client does not currently execute explicit fee-vs-rediscovery decisions because route pricing is not shipped. |
| Route-level pricing | Coming soon | No x402 or marketplace fee flow in the current codebase. |
| HTTP 402 payment handshake | Coming soon | Not implemented. |
| x402 settlement | Coming soon | Not implemented. |
| USDC on Solana settlement | Coming soon | Not implemented. |
| Fee splits across contributors, maintainers, infra, treasury | Coming soon | Not implemented. |
| Delta-based attribution for route improvements | Coming soon | Not implemented. |
| Contributor payouts | Coming soon | Not implemented. |
| Site-owner compensation and opt-in monetization | Coming soon | Not implemented. |
| Dynamic route pricing based on savings and trust | Coming soon | Not implemented. |

## Trust and Validation

| Paper claim | Status | Notes |
| --- | --- | --- |
| Feedback-driven route quality | Shipped | Feedback contributes to reliability scoring. |
| Verification status affects ranking | Shipped | Verification status is part of composite scoring. |
| Freshness affects ranking | Shipped | Freshness contributes to ranking today. |
| Background endpoint verification | Shipped | Safe GET verification loop exists. |
| Pre-publish quality gate | Partial | There are local quality checks and passive publish gating, but not the exact formal validator pipeline described in the paper. |
| Continuous trust score with signed feedback and validator attestations | Partial | There is a practical reliability model today, but not the full signed multi-signal trust system described in the paper. |
| Independent validators with staking/slashing | Coming soon | Not implemented. |
| E2B sandbox validation | Coming soon | Not implemented in the current codebase. |
| TEE attestation for verification proofs | Coming soon | Not implemented. |

## Benchmark and Evaluation Claims

| Paper claim | Status | Notes |
| --- | --- | --- |
| Warm-cache vs browser benchmark framing | Shipped | The repo includes canonical evals and benchmark-style harnesses. |
| Benchmark-backed product evals | Shipped | `eval:core` and related WebArena-backed lanes exist. |
| Full 94-domain paper benchmark | Partial | The paper reports it; current repo focus is the canonical eval stack and adapted benchmark corpora, not only the original paper benchmark. |
| WebArena-style multistep evaluation | Shipped | Present in the repo and part of the eval story. |
| WebArena-Verified adapted corpus | Shipped | Present in the repo as an adapted corpus and stable verified slice. |

## Read This As

The paper is best understood as:

- a real description of the current capability layer
- a partially realized description of trust and graph infrastructure
- a forward-looking roadmap for the route economy

Any paper section that depends on payments, payouts, validator staking, or cryptographic attestation should currently be read as `coming soon`.
