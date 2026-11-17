# owner-key-writes-never-share-a-nonce

**Focus:** 2 Concurrency. **Confidence:** high. **Status:** confirmed defect by scratch probe (commit 91115204).

## Property

Two on-chain writes the node makes with its owner key at the same time never take the same nonce: neither fails, nor
is dropped, because the other write used its nonce.

## Code paths

- Every owner-key write builds its own provider: `chain::as_signer` -> `paying` (`chain.rs:574-602`) calls
  `ProviderBuilder::new().wallet(..).connect_http(url())`. The recommended fillers include `NonceFiller` with
  `CachedNonceManager` (alloy-provider 1.8.3 `fillers/mod.rs:838`, `fillers/nonce.rs:56-90`). The cache lives in the
  filler instance, so a fresh provider fetches `eth_getTransactionCount(pending)` afresh. alloy's own doc
  (`nonce.rs:91-99`): "Using two providers with their own nonce layer can potentially fill invalid nonces if
  transactions are sent from the same address".
- `erc8004::publish` and `erc8004::ensure` build their own the same way (`erc8004.rs:86,140`).
- Writers that can run at once (sut-analysis §3):
  - the claim loop (`main.rs:1438-1453`): `claimBatch` (`chain.rs:1418`, `:1552`), `setFee` (`main.rs:604`),
    `holdRoute`/`releaseHold` (`peers.rs:443,471,501`);
  - owner API commands (`main.rs:1231-1296`, one axum task each): `deposit`, `post_bond`, `list_route` (`listEntry`,
    `setFee`, `postRoot`, and `erc8004::ensure` via `listing::own_identity`, `listing.rs:187-191`), `agent_create`
    (`authorizeAgent`), `claim_now`;
  - the address republish loop (`peers.rs:361-375`, `setMetadata` x3, `setAgentURI`) and `peers::start`'s first
    `publish` and `ensure` (`peers.rs:317,356`).
- Writes are `send!` (`chain.rs:618-627`): a failed `send()` surfaces as an `Err` to the caller.

## Probe (scratch copy, not the repo)

`life-probe/unbrowse-node/app/src/chain.rs`, test `probe_two_owner_writes_at_once_pick_the_same_nonce`: two
`as_signer` providers for one key, each sending a distinct 0-value transfer at the same moment, 10 rounds.

- Anvil automine: `10 ok, 10 failed ... errors: ["... -32003: replacement transaction underpriced"]`.
- Anvil `--block-time 1`: same, `10 ok, 10 failed`.
- Staggered by 2-80 ms (in `probe_staggered_ensures_register_twice`, two `erc8004::ensure` calls): the first caller
  fails every time with `-32003: nonce too low` on its follow-up `setMetadata`, because the second caller's `register`
  took that nonce.

So one of two concurrent writes fails in every round, with no network fault.

## What a lost write costs, by writer

- `claimBatch`: retried next minute. Harmless unless the window is about to close.
- `releaseHold` in `hold_tick` when holding is off: the error is ignored and `held.json` is cleared anyway
  (`peers.rs:441-448`). The hold stays on chain for good. See `holding-on-chain-converges-to-held-json`.
- `holdRoute`: skipped this tick, tried again next tick.
- `setMetadata` in `ensure` after `register` landed: `ensure` returns `Err`, the registration file is never written,
  and the next start registers again. See `one-erc8004-identity-per-owner`.
- `publish` in `peers::start`: `peers::start` returns `Err` and is never retried (`main.rs:1429`). See
  `node-on-network-after-first-publish-fails` (another focus) and `boot-failures-heal-without-restart`.
- Owner commands: the owner sees an error and may retry.

The topology's workload makes owner calls (`deposit`, `post_bond`, `list_route`, `agent_create`) right after boot,
while `peers::start` runs `ensure` and `publish`, which is the most likely collision.

## Antithesis angle

No fault is needed. Thread pausing and CPU modulation widen the window between the nonce fetch and
`eth_sendRawTransaction`. Node-to-chain latency widens it further. `parallel_driver_owner` running alongside the
claim loop and boot is enough.

## Instrumentation (none exists, per existing-assertions.md)

- SUT, **missing**: in `send!` (`chain.rs:618-627`) and the four raw `send()` sites in `erc8004.rs`, an
  `Unreachable("owner-key write refused for its nonce")` when the send error contains `nonce too low`,
  `replacement transaction underpriced`, `already known` or `already imported`. Details: the write's name, the nonce.
- SUT, **missing**: `Sometimes("two owner-key writes in flight at once")`. Keep an atomic counter around `as_signer`
  + `send!` and fire when it reaches 2. That shows the interleaving was explored.
- Workload: read each node's owner nonce from the chain. Every `nonce too low` / `underpriced` message the owner API
  returns is a failure of this property.

## Open questions

- Is a single process-wide signer provider (one `CachedNonceManager`), or a write mutex, the intended model? The answer
  decides whether the assertion should also cover writes the owner runs from a second process (`unbrowse-node chain
  ...` CLI commands go through the API at `main.rs:1186`, so they are in the same process. The CLI `wallet restore`
  path was not checked).
- On a chain that doesn't automine (Arc), could a same-nonce write with higher fees replace a write already
  in the mempool? Then the first writer's `get_receipt()` (no timeout) would wait forever. Anvil rejected equal-fee
  replacements in the probe, so this was not seen.
