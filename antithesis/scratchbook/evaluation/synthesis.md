---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
external_references:
  - path: <checkout>/papers/protocol.md
    why: Numbered protocol requirements (R2, R3, R6, R7) read as claims to test.
  - path: <checkout>/papers/economy.md
    why: Fee rail, split, bond, withholding, vesting, burn, read as claims to test.
  - path: AGENTS.md, CLAUDE.md (repo root)
    why: Network rules ("one owner is one source", standing from the registry); fixes stated as properties.
  - path: <checkout>/autofetch (branch autonomous-fetch, PR #53)
    why: The no-approval spending path; read as a lead by the wildcard focus.
---

# Evaluation synthesis (single-agent pass)

The skill's evaluation step can run as an ensemble of lens agents. This pass was done by the orchestrator alone, to keep the run bounded, so treat it as lighter than the skill intends. A fresh-context ensemble evaluation is still open.

## Refinements applied
- **Overlaps merged in relationships, not deleted:**
  - `caller-runs-only-the-signed-body` ⊇ `served-body-matches-signed-content-id`
  - `node-on-network-after-first-publish-fails` ≈ `boot-failures-heal-without-restart`
  - the boot and claim-loop overlaps flagged by the lifecycle agent

  Both evidence files are kept because they cite different code paths.
- **`network-write-never-auto-run-for-a-read-intent` is now fixed on PR #53** (61365f6a). The network path decides read intent by `!writes_goal(goal)`, with the test `a_paid_network_write_runs_only_for_a_goal_that_asks_for_a_change`. The property stays as a regression guard.
- **Question 9 (the deck's update) is resolved from session history:** the deck used its own launcher script.

## Gaps (no property yet)
- **Agent key lifecycle:** revoke, pause and cap changes racing an in-flight paid call (`agents.rs`). The money agent left this to concurrency, and the concurrency agent didn't take it.
- **Local API boundary:** the Host-header check and 127.0.0.1 binding under DNS rebinding (`api.rs:1291,1303-1320`). The existing security-audit runs covered this, so it is lower priority here.
- **Rate limits:** no property for R7.18 and R7.26 per-peer limits. The code has none, so a property would be vacuous until the limits exist. Recorded as an open question on `listings-answering-survives-a-stuck-answer`.
- **Clock-dependent behaviour:** the epoch is `block.timestamp / 86400`. The workload drives the chain clock itself, so clock jitter in the node containers is barely exercised. Fine for now.

## Biases to raise with the owner
- **Detection over workload design:** the catalog leans towards defects found by reading code. Many properties are already-known failures, which is valuable as regression targets, but it means Antithesis's search is mainly needed for the timing-dependent ones:
  - the cap race
  - nonce collisions
  - admission under partitions
  - holding drift
  - stuck listings answers
- **Unit mismatch hidden by devnet:** devnet uses 18-decimal tokens at par, so every existing test hides any USDC/UNB scale mismatch. Live-network money properties need a 6-decimal USDC in the chain container.

## Recommended order
1. **Fix the confirmed money defects before `chain deploy` on arc-testnet:**
   - withholding as UNB (cluster 1)
   - the serving share burned
   - the cap refusal after the site call, and kept bodies with no line
   - the all-or-nothing claim batch
   - the vesting gas wall
2. **Fix the network liveness defects. Each one is small:**
   - re-read seeds while the table is empty
   - put timeouts on registry reads and listings answers
   - cap the size of listings answers
   - clear `admitted` on a too-old Identify
   - use one shared signer or a write lock for owner-key writes
   - retry boot steps
3. **Then build the Antithesis harness:** `antithesis-setup`, then `antithesis-workload` using `deployment-topology.md`. Start with the net-only harness for the admission properties.
