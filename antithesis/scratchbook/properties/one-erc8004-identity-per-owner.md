# one-erc8004-identity-per-owner

**Focus:** 3 Failure Recovery, 2 Concurrency. **Confidence:** high. **Status:** confirmed defect by scratch probe (commit 91115204), on two paths.

## Property

A node registers its owner's ERC-8004 identity on a chain at most once: across crashes, failed writes, restarts and
concurrent callers, the chain holds one `Registered` event per owner address.

## Claimed guarantee

- `erc8004.rs:1`: "one identity per wallet, registered once in Arc's IdentityRegistry."
- `erc8004.rs:69-70` (`ensure`): "The owner's identity on this chain, registering it the first time."
- AGENTS.md: "one owner is one source".

## Code paths

- `erc8004::ensure` (`erc8004.rs:72-117`):
  - `:76-79` the only check for an existing identity is the local file `erc8004-<owner>.json` (`saved_path`, `:56-62`).
    The chain is never asked whether this owner already registered.
  - `:86-95` `register(uri)`: send, then `get_receipt()`.
  - `:107-108` `setMetadata(REGISTERED_AT)`: another send and receipt. Any error returns `Err` before the file is written.
  - `:116` `store::write_json(saved_path)`: the file is written last.
  - No lock around any of it.
- Callers: `peers::start_serving` (`peers.rs:317`, at boot) and `listing::own_identity` (`listing.rs:187-191`, on every
  owner `list_route` -> `listing::publish`, `listing.rs:283-289`). Both can run at once at boot.
- After `peers::start` fails it is not retried in the process (`main.rs:1425-1430`). The next attempt is the next boot,
  which finds no file and registers again.

## Failure windows

1. Kill -9, or an update `hand_over` exec (`update.rs:192-206`, which waits only for API requests counted in `IN_FLIGHT`, `update.rs:213-235`),
   between `register` landing and `:116`.
2. `get_receipt()` of `register` errors after the tx was mined (a dropped connection).
3. `setMetadata(REGISTERED_AT)` fails: an RPC fault, or a nonce collision with a concurrent owner write
   (`owner-key-writes-never-share-a-nonce`).
4. `write_json` fails: a full disk. On a full volume the atomic tmp-then-rename write fails, because it needs a new
   block (disk-full probe in `life-probe/.../update.rs::probe_a_full_disk`: `write_json held -> Err("No space left on
   device")`).
5. Two `ensure` calls overlap: both see no file and both register.

## Probe (scratch copy, not the repo)

`life-probe/unbrowse-node/app/src/erc8004.rs` `mod life_probe`: Anvil `--chain-id 5042002`, a minimal ERC-8004
stand-in (`life-probe/reg/src/Reg.sol`) at arc-testnet's registry address (`anvil_setCode`), Chain with deployment
chain id 5042002 so `registry_of` resolves the registry.

- Window 1/2/3/4, modelled by deleting the registration file after a successful `ensure`, then calling `ensure` again:
  `first id 2 then 3; Registered events for the owner: 2`.
- Window 5, two `ensure`s started 2, 5, 10, 20, 40 and 80 ms apart: **2 `Registered` events for the owner in all six
  runs**. The first caller also fails each time (`-32003: nonce too low`, on its `setMetadata`, because the second
  caller's `register` took that nonce). In the node, that failing caller would be `peers::start`, which then never joins.
- Exactly simultaneous calls send identical txs, and the second fails with "transaction already imported". One
  identity, one caller fails.

## Why it matters

- Every extra identity costs gas, and the orphan carries no metadata. Under a full disk each restart registers once
  more, because each one fails at `:116` again.
- An owner with several identities sits against the "one owner is one source" rule. Today an orphan has no
  `unbrowse.peerId`, so `seeds()` and lookups ignore it. But the listing a concurrent `list_route` signed names the
  identity its own `ensure` returned (`listing.rs:288`), which may not be the identity whose file won. The node then
  serves listings under one identity while its peer key is placed for another.

## Antithesis angle

- Node termination during boot (windows 1-4): needs node termination enabled.
- No termination needed for windows 2, 3 and 5: node-to-chain faults during boot, plus the workload's `list_route`
  right after `/v1/whoami` answers.
- A custom fault that fills `/data` drives window 4.

## Instrumentation (none exists)

- Workload, **missing** (`anytime_` / `finally_`): for each node's owner address, count `Registered(uint256 indexed,
  string, address indexed owner)` logs at the registry: `Always(count <= 1)`. Pure eth_getLogs with topic2 = owner.
- SUT, **missing**: in `ensure` before `register`, `AlwaysOrUnreachable("registers only an owner the registry has no
  identity for")`. That needs a chain read of the owner's existing registrations, which is also the fix's shape.
- SUT, **missing**: `Reachable("ensure registered a new identity")` and `Reachable("ensure reused the saved
  identity")`, to see both branches explored.

## Open questions

- Does the real Arc IdentityRegistry offer a lookup by owner (balanceOf / an index), or must the node scan
  `Registered` logs from `registry_from`? This decides how cheap the check and the fix are.
- Should a concurrent `list_route` during boot wait for `peers::start`'s `ensure` (one in-process lock), or is
  re-deriving from the chain enough?
