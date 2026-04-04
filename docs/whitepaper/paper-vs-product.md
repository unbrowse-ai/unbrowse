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
| Economic adoption condition `froute < c_rediscovery` | Partial | The framing is documented and unpaid paths can fall back to free indexing/live capture, but the client does not yet run an explicit optimizer over route price versus rediscovery cost. |
| Route-level pricing | Shipped | Skills and marketplace search can advertise prices and gate access through the shipped payment lane. |
| HTTP 402 payment handshake | Shipped | Resolve/execute/search surfaces can return `payment_required` with x402-compatible payment requirements. |
| x402 settlement | Shipped | The x402-compatible gate path ships today end-to-end, while wallet signing/broadcast and final transaction execution remain delegated to the external wallet provider / Corbits-compatible facilitator. |
| USDC on Solana settlement | Shipped | The shipped lane advertises and settles USDC payment terms on Solana and Base through the external facilitator / wallet path; Unbrowse does not custody or sign transactions itself. |
| Fee splits across contributors, maintainers, infra, treasury | Partial | Payment routing and split plumbing exist, but the paper’s richer automatic multi-party split architecture is not implemented in full. |
| Delta-based attribution for route improvements | Partial | Current payout routing narrows to the winning contributor wallet; the paper’s full attribution model is broader than what ships today. |
| Contributor payouts | Shipped | Wallet-linked creator payout identity, transaction/earnings surfaces, and current payout routing exist today, though in a narrower form than the full paper economy. |
| Site-owner compensation and opt-in monetization | Partial | The product surface includes opt-in per-execution pricing hooks, but not the complete paper-era site-owner economy. |
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

Any paper section that depends on the full route economy, validator staking, or cryptographic attestation should be read carefully: the narrow payment lane ships today, but the broader paper-era economics are still only partial.
