# Unbrowse Task List

Generated from the Proof of Indexing paper, Machine Intent routing paper, and codebase review.

## P0: Ship Now (Phase 1 foundations)

### Telemetry Collection
- [ ] **Add execution telemetry to orchestrator** — After every route execution in `src/orchestrator/index.ts`, log a structured record: `{route_id, indexer_id, domain, method, status_code, response_size, latency_ms, schema_match, timestamp, goal_hash}`. Write to local `~/.unbrowse/telemetry/` as NDJSON. This is the training data for the router (paper: "request traces are machine intent").
- [ ] **Add response hash to execution output** — In `src/execution/index.ts`, compute `sha256(status_code + response_body)` after every execution. Store alongside telemetry. This is the structural hash for feedback integrity (FDRY paper).
- [ ] **Opt-in telemetry upload** — Add `--telemetry` flag to CLI. When enabled, batch-upload telemetry records to the marketplace backend on a schedule (every 10 min or every 50 records). Off by default. This is the passive feedback stream for Proof of Indexing.
- [ ] **Track session sequences** — In `src/orchestrator/index.ts`, assign a `session_id` to each multi-step resolution. Log the ordered sequence of endpoints called per session. This is the training data for DAG extraction and sequential recommendation.

### Endpoint Graph Construction
- [ ] **Build endpoint relationship graph from skill metadata** — In `src/graph/index.ts`, construct edges between endpoints: same-domain, shares-auth (same auth profile), data-flows-to (response field matches next request's parameter). Store as adjacency list in `~/.unbrowse/graph.json`. This is the KGE input (routing paper Phase 1.3).
- [ ] **Add schema fingerprint to endpoints** — When publishing a skill, compute a structural hash of the response schema (field names, types, nesting depth). Store in skill manifest. This enables cross-domain structural similarity (routing paper: cross-domain transfer).

### Feedback Infrastructure
- [ ] **Define feedback record schema** — Create `src/types/feedback.ts` with: `{route_id, indexer_id, session_id, status_code, response_hash, response_size_bytes, latency_ms, schema_match: boolean, x402_payment_proof?, timestamp}`. This is the raw artifact format from the FDRY paper (not self-reported scores — system-derived).
- [ ] **Wire feedback submission into execution path** — After `src/execution/index.ts` completes a route execution, automatically create a feedback record from the execution result. No user action needed. This is the "automatic feedback" from the FDRY paper.

## P1: Proof of Indexing Preparation (Phase 2)

### On-chain Identity
- [ ] **Integrate Agent Registry (ERC-8004 on Solana)** — Register Unbrowse indexers via Quantu AI's Agent Registry (`https://8004.qnt.sh`). Store agent NFT reference in local config. This is the identity layer from the FDRY paper.
- [ ] **Add indexer identity to skill publishing** — When publishing a skill to the marketplace, attach the indexer's Agent Registry identity. This enables portfolio-level attribution.

### Reputation
- [ ] **Submit feedback records to Agent Registry** — Batch-submit feedback records to the ATOM reputation system. Link each record to the x402 payment proof. This is the reputation layer from the FDRY paper.
- [ ] **Compute portfolio-level trust scores** — Aggregate feedback scores per indexer across all their routes. Display in marketplace. This is the reputational accountability (Tier 1) from the FDRY paper.

### Staking Contract
- [ ] **Design FDRY staking contract (Solana program)** — Stake deposits, unbonding period (14-30 days), slash execution triggered by reputation registry scores, burn-on-slash. This is the core Proof of Indexing component.
- [ ] **Implement quorum + supermajority slash triggers** — Slash fires only when: (1) total sqrt(staked_FDRY)-weighted feedback exceeds quorum Q, AND (2) negative share exceeds supermajority σ (67%). Both thresholds from the FDRY paper.
- [ ] **Implement domain-level circuit breaker** — If >50% of routes on a single domain fail simultaneously, suppress slashing for that domain. This distinguishes upstream outages from indexer negligence.
- [ ] **Implement acknowledge-and-delist** — Allow indexers to proactively delist a failing route within the grace period to avoid slashing. Slashing punishes neglect, not failure.

## P2: Router Validation Experiments (Phase 2-3)

### Experiment 1: Graph vs Flat Search
- [ ] **Collect 100 multi-step traces** — From telemetry data (P0), extract 100 sessions with 3+ sequential endpoint calls.
- [ ] **Run held-out evaluation** — At each step, hold out the next action. Compare Recall@5: current composite scoring vs graph-filtered composite scoring (filter to reachable endpoints only).
- [ ] **Report results** — If graph-aware wins, proceed to KGE. If not, flat search is sufficient.

### Experiment 2: Stateful vs Stateless
- [ ] **Add session-state conditional rule** — In `src/orchestrator/index.ts`, if the agent has already called an auth endpoint on this domain in this session, boost endpoints that require auth. Simple if-then rule, no model.
- [ ] **Run held-out evaluation** — Same 100 traces. Compare Recall@5: stateless vs stateful.
- [ ] **Report results** — If stateful wins, proceed to SASRec. If not, stateless is sufficient.

### Experiment 3: Context Matters?
- [ ] **Create test set** — 20 goals where the ideal route differs by role (developer vs analyst vs trader). Manually label expected differences.
- [ ] **Evaluate** — Send same goals from two CLI instances with different CLAUDE.md contexts. Check if current system differentiates (it shouldn't). Confirm the labeled differences are real.

## P3: First Router (Phase 3)

### KGE Layer (if Experiment 1 validates)
- [ ] **Train RotatE embeddings on endpoint graph** — Use the graph from P0. Embed endpoints in complex space. Evaluate link prediction accuracy.
- [ ] **Replace graph filtering with KGE-based reachability scoring** — Instead of hard graph filtering, use KGE similarity to score reachability. Soft constraint.

### Sequential Model (if Experiment 2 validates)
- [ ] **Train SASRec on action sequences** — Use session traces from telemetry. Input: sequence of endpoint embeddings. Output: next endpoint prediction.
- [ ] **Integrate SASRec scoring into orchestrator** — Blend SASRec next-action score with existing composite scoring.

### Personalization (if Experiment 3 validates)
- [ ] **Encode CLAUDE.md as context vector** — Extract role, domain preferences, and constraints from project context. Embed as vector.
- [ ] **Add history encoding** — Compress agent's execution history (domains used, success rates, frequency) into a fixed-size vector.
- [ ] **Condition routing on context** — Concatenate context vector with goal embedding for retrieval.

### A/B Test
- [ ] **Router vs baseline on live traffic** — Deploy router alongside existing composite scoring. Split traffic. Measure: success rate, latency, user satisfaction.

## P4: Full Router Stack (if A/B validates)

- [ ] Evaluate EBM vs classifier on action scoring
- [ ] Evaluate HSTU vs SASRec at scale
- [ ] Add latent intent variable z
- [ ] Test cross-domain transfer (train on domain A, eval on domain B)
- [ ] Online learning: continuous model update from new traces
- [ ] Scale: route majority of agent traffic through the router

---

## Issues / Known Gaps

### From FDRY Paper Review
- [ ] **Upstream site changes indistinguishable from negligence** — Grace period + circuit breaker mitigate but don't solve. Slash fraction s should be conservative.
- [ ] **Short selling + sabotage attack** — Not solvable within protocol. Unbonding period is the only mitigation.
- [ ] **Feedback submission costs at scale** — Need batching implementation. Current design is per-execution on-chain submission.
- [ ] **sqrt(staked) Sybil splitting** — Minimum stake threshold partially addresses. Monitor for wallet fragmentation.
- [ ] **Early-phase FDRY liquidity** — Dual-exposure mechanism is weak until liquidity deepens. Phase 1-2 operate without FDRY.

### From Routing Paper Review
- [ ] **No empirical validation yet** — All architecture claims are speculative until the three validation experiments run.
- [ ] **HSTU is wrong scale for current system** — Use SASRec until trace volume justifies HSTU.
- [ ] **EBM vs classifier unresolved** — Don't commit until Experiment 2 validates and simple classifier is tried first.
- [ ] **Latent intent adds complexity** — Explicit context vector may be sufficient. Validate before adding latent z.
- [ ] **Cross-domain transfer via structural embeddings is weak** — Schema similarity is a noisy signal. Behavioral similarity from traces is stronger but requires traces.

### From Codebase Review
- [ ] **No execution telemetry collection** — The system filters OUT telemetry from captured sites but doesn't collect its OWN execution telemetry. This is the #1 gap — all future work depends on traces.
- [ ] **No session tracking** — Multi-step resolutions don't have session IDs. Can't extract action sequences without them.
- [ ] **No feedback loop** — Execution results are not fed back to the graph. Success/failure of route execution is not recorded anywhere persistent.
- [ ] **`traces/` directory is raw HAR** — Not structured for ML training. Need a pipeline to convert HAR → structured action sequences.
