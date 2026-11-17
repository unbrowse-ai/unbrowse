---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
external_references:
  - path: <checkout>/papers/protocol.md
    why: The protocol spec. Its numbered requirements (R1.15, R3.9-R3.28, R6.8-R6.22, R7.18-R7.27) are the claimed guarantees for routes, listings, fetching, serving, seeding, NAT, admission and joining with no bootstrap list. Read as claims to test.
  - path: <checkout>/papers/economy.md
    why: The fee rail, the 55/30/5/5/5 split, the bond, withholding, vesting and the burn. Read as claims to test.
  - path: AGENTS.md (repo root)
    why: The network section ("standing is read from the registry", "one owner is one source", "a listing is checked before an agent sees it").
  - path: CLAUDE.md (repo root)
    why: Fixes must be general, with no site names in the engine. This binds the next stages, not this analysis.
---

# SUT analysis: the Unbrowse node's network and money paths

**Scope (the user's answer, verbatim):** "Review everything with antithesis-skills; focus on the networked node"

- **In scope:** `unbrowse-node/crates/net` (libp2p 0.57.1); `unbrowse-node/app/src/{peers,share,listing,recipe,chain,network,agents,api,store,update,main,erc8004,arc}.rs`; `unbrowse-settlement/src/lean/*.sol`; the launcher's choice of which binary runs (`unbrowse-sdk/typescript/src/cli.ts`, `update.rs`).
- **Out of scope:** the browser engine, the learner (`learn.rs`, `crates/learn`), UI and window, telemetry, marketing.

All paths below are relative to `sut_path`. "Claims" are what docs or comments say. This file does not say any of them hold; each one is a property to test.

## 1. Architecture and data flow

| Component | Where | What it does |
|---|---|---|
| Swarm actor | `crates/net/src/node.rs:771-801` | One tokio task owns the libp2p `Swarm`. It `select!`s over commands (`mpsc(256)`), internal results (`unbounded`) and swarm events. Protocols: Kad `/unbrowse/kad/1.0.0`, Identify, `hello`, `listings`, `/unbrowse/body/1`, AutoNAT, relay v2, relay client, DCUtR (`node.rs:189-200`). |
| Admission | `crates/net/src/admission.rs:62-74`, `node.rs:897-918,1011-1018` | When a connection opens the node sends `hello`. A spawned task reads `Registry::identity` and runs `admit()`: the peer must be listed, its index below 16, and its position placed (`position.rs:22-44`). Peers enter the table only by hand (`BucketInserts::Manual`), and provider records pass `StoreInserts::FilterBoth` (`node.rs:288-295`). |
| Join | `node.rs:558-586` | Dials the saved table, sleeps 3 s, reads `registry.seeds()` **once** if the table is empty, then loops every 2 s until the table is non-empty, bootstraps, and then bootstraps and saves every 600 s. |
| Site lookup | `node.rs:371-409,535-543` | Gets providers for `/unbrowse/site/<domain>` (at most 32), admits up to 4 at a time, keeps one per identity (at most 8), fetches `listings` from each with a 15 s timeout, and filters. `checked` is true when at least 2 distinct identities answered (`Config::new`, `node.rs:133-154`). |
| Body transport | `crates/net/src/body.rs`, `node.rs:426-474,1050-1084` | Request/response with bounds: content id at most 256 B, payment at most 4 KiB, body at most 64 KiB. Caller timeout is 15 s (`BODY_TIMEOUT`) and the server-side store timeout is 10 s (`SERVE_TIMEOUT`). Limits are 16 concurrent answers and a per-peer token bucket of burst 20 at 1/s (`body.rs:245`). |
| Registry | `app/src/erc8004.rs:174-238`, `peers.rs:49-88` | Reads ERC-8004 metadata (`unbrowse.peerId`, `unbrowse.addrs`, `unbrowse.registeredAt`) over RPC, plus the `Registered` log for the anchor. On a devnet with no registry, `DevnetRegistry` reads JSON ads from a shared folder (`network.rs:27-91`). |
| Node wiring | `app/src/peers.rs:313-407` | Registers the identity (`erc8004::ensure`) and grinds or loads the key (`peer-key.json`). Live mode listens on every interface at a fixed port; devnet listens on 127.0.0.1 only (`peers.rs:328-338`). It publishes addresses and re-checks every 30 s (`peers.rs:361-375`), announces its own sites and bodies (`peers.rs:384-405`), and answers listings from `ServedListings` (`peers.rs:141-165`). |
| Fetch and pay | `app/src/api.rs:728-797`, `share.rs:253-323`, `network.rs:241-329` | A caller checks the signed listing (`listing.rs:196-215`), signs a `BodyFetch` EIP-712 voucher for each provider (`network.rs:173-265`), checks bytes against the content id (`recipe.rs:390-401`), keeps the body as a route, runs it locally against the site, and appends a receipt line (`chain.rs:1215-1248`). |
| Serve | `share.rs:139-168`, `network.rs:317-329` | The server checks the voucher signature, the agent, `spendable`, the epoch window and nonce replay (in-memory `SPENT`), then records `SERVED` in memory and releases the body. |
| Receipts and claims | `chain.rs:1122-1597`, `network.rs:362-419` | Per-(agent, epoch) receipt files. A running voucher is signed over a Merkle root of the lines. `claim()` batches the passed lines. The contributor's node gets lines over `POST /v1/remote/receipt` (`owed.json`) and claims them in `claim_owed()`. |
| Agent API | `api.rs:1265-1298,1303-1320` | axum on **127.0.0.1 only**, with a Host-header allowlist (`127.0.0.1:<port>`, `localhost:<port>`). Agents use Bearer tokens (`agents.rs:168-176`). The owner uses `/owner/{cmd}` with the token from `owner.token`. |
| Chain client | `chain.rs:377-512,574-627` | Devnet (spawns or adopts Anvil on 127.0.0.1) or live (`UNBROWSE_CHAIN`/`UNBROWSE_RPC`). Every call builds a fresh alloy HTTP provider. Writes are `send()` then `get_receipt()` with no timeout (`send!`, `chain.rs:618-627`). |
| Settlement | `unbrowse-settlement/src/lean/LeanSettlement.sol` | Deposits and 2-epoch withdrawals (`:311-354`), agent keys and caps (`:364-436`), bond price, join, target and withholding (`:444-703`), entries and fees (`:711-748`), `postRoot` (`:757-768`), holds (`:774-785`), claims and the split (`:883-997`), vesting (`:1001-1042`). The epoch is `block.number / epochBlocks` (`epoch()`, R1.28). |
| Launcher and update | `unbrowse-sdk/typescript/src/cli.ts:56-68,134-144`, `app/src/update.rs:170-206,325-414` | `unbrowse` runs `$UNBROWSE_BIN`, else the app bundle, else the platform package's `bin/unbrowse-node`. At startup that binary execs `~/.unbrowse/versions/<current>` if it is newer (`run_newest`, release builds only). Every 6 h it checks npm, verifies the ed25519-signed manifest (hard-coded key, `update.rs:29`), unpacks, renames and writes `current`. |

**Main request paths**
1. *Search:* `GET /v1/routes` → `ask_network` → `peers::find` → `Net::find` → `listing::verify` on each listing (3 chain reads each) → falls back to `search_network` (scans every `EntryListed` log) (`api.rs:96-126`).
2. *Network call:* `do_call`/`do_goal` → `call_entry` (`api.rs:728`). The entry and epoch are read, the dark-entry check runs, `listing_of`, then `agent_spend` (cap) and `spendable` (deposit) are read, then `covers`, then `share::fetch` (one voucher per provider), then `run_route` (spawn_blocking HTTP to the site), then `add_network_receipt`, then `send_receipt` to the contributor's endpoint.
3. *Claim loop:* `main.rs:1438-1453`, every 60 s and in sequence: `claim_all` (each agent, epochs e-1 and e, then `claim_owed`), then `reprice`, then `peers::hold_tick`.

## 2. State and persistence

All files are under `UNBROWSE_HOME` (default `~/.unbrowse`). Writes use `write_private` (tmp file then `rename`, no fsync; `crates/learn/src/client.rs:561-573`) unless the table says otherwise. `read_json` turns a parse error into the default (`store.rs:60-62`). `read_json_strict` is used only for the listing book and `agents.json`.

| State | File / place | Writer(s) | Notes |
|---|---|---|---|
| Root key | `root.key` (Linux headless), `devnet/root.key` (debug build) | `main.rs:86-104` (`root_store`, `root_in_file`) | Agent keys and tokens derive from it. |
| Settings | `settings.json` | owner API, CLI | Read on every check (`light`, `paused`, `hold_routes`, `peer_network`). Never cached. |
| Agents | `agents.json` + `agents.lock` flock | `agents.rs:61-166` | Locked across processes. |
| Peer key | `peer-key.json` | `peers.rs:189-204` | Re-ground when the identity, anchor or bits change. |
| Peer port | `peer-port.json` | `peers.rs:224-240` | Overridden by `UNBROWSE_PEER_PORT`. |
| Last published | `peer-published.json` | `peers.rs:276-283` | |
| Routing table | `peer-table.json` | `node.rs:603-608` | **`std::fs::write`, not atomic**. Saved every 600 s. A torn file reads as empty (`unwrap_or_default`, `node.rs:596`). |
| Node ads | `$UNBROWSE_NETWORK_DIR/<addr>.json` | `network.rs:71-91` | Devnet registry and receipt endpoint discovery. Only one machine can see them. |
| ERC-8004 registration | `erc8004-<owner>.json` or `<net>/erc8004-…` | `erc8004.rs:72-120` | |
| Network file | `networks/<net>.json` | `chain deploy` | Overrides the built-in `app/networks/*.json`. |
| Devnet | `devnet/{state.json,deployment.json,deployer.key,mark.key,network.json}` | `chain.rs:266-476` | |
| Listing book | `listings-<chainid>-<settlement>.json` | `listing.rs:294-322` under `BOOK` tokio mutex | Root posted, then the book is written. |
| Bodies | `bodies/sha256-<hex>.json` | `recipe.rs:471-481` | Content-addressed and checked on load. |
| Routes | `routes/<id>.json` | `store.rs:299-340` under `ROUTES` mutex | Fetched bodies become routes with `fetched`. |
| Held listings | `held.json` | `peers.rs:437-514` only | Read, then many chain txs, then written. Not locked. |
| Pricing | `pricing.json` | `main.rs:561-611` | |
| Receipts | `<chaindir>/receipts/<agent>-<epoch>.json` | `chain.rs:1160-1248`, `:1337-1428` under `LEDGER` (sync mutex) | `index = all.len()`. |
| Owed lines | `<chaindir>/owed.json` | `chain.rs:1503-1522` under `LEDGER` | |
| Update | `versions/{manifest.json,manifest.sig,current,<v>/}` | `update.rs:325-369` | `current` uses plain `std::fs::write`. |
| **In memory only** | `SPENT` (vouchers spent, `network.rs:300`), `SERVED` (bodies served, `network.rs:335`), `Share{providers,dark,listings}` (`share.rs:27-34`), `OWN` listings cache (`peers.rs:101`), all `State` maps (`node.rs:610-645`) | | A restart loses all of these. |

**On-chain** (LeanSettlement): `_accounts` balance/pending/availableAt; `_agents` cap/expiry/revokedAt plus `_kept` terms; `_claimed[payer][agent][epoch]`; `spentLine[keccak(payer,agent,epoch,leaf)]`; `_bond` filled/base/unbonding; bond price, window and φ aggregates; `_vesting[]`; `_entries`; `feeOf`; `holding`; `escrow[domainHash]`; `_rootBlock`. ERC-8004 registry metadata is external.

## 3. Concurrency model

- One multi-thread tokio runtime (`main.rs:1357`). Long-lived tasks:
  - the swarm actor (`node.rs:348`), plus a spawned task per hello verdict (`:1013`), per listings answer (`:1034`) and per body serve (`:1067`);
  - `join` (`node.rs:350,558`);
  - the address republish loop (`peers.rs:361-375`);
  - the announce task (`peers.rs:384-405`);
  - the chain/claim loop (`main.rs:1403-1455`);
  - axum handlers, one per request;
  - the update thread (`update.rs:372-413`) and the identity thread (`main.rs:1395-1399`).
- Locks: `LEDGER` (std mutex for receipts and owed), `CLAIMING` (tokio, one claim pass at a time, `chain.rs:1150-1153`), `BOOK` (tokio, `listing.rs:251`), `ROUTES` (std, `store.rs:299`), `OWN` (tokio, **held across a chain read**, `peers.rs:143-149`), `SPENT` and `SERVED` (std), `agents.lock` (flock). `held.json`, `pricing.json` and `settings.json` have no lock.
- Owner-key writers that may run at once: the claim loop (`claimBatch`, `setFee`, `holdRoute`/`releaseHold`), owner API commands (`listEntry`, `setFee`, `postRoot`, `authorizeAgent`, `deposit`), and the republish loop (`setMetadata` ×3, `setAgentURI`). Each builds its own provider with alloy's `CachedNonceManager`, so each new provider fetches the account nonce afresh (alloy-provider 1.8.3 `fillers/mod.rs:838`, `nonce.rs:121`). Two at once can pick the same nonce.
- Background ticks:
  - claim, reprice and hold every 60 s, in sequence;
  - Kad bootstrap and table save every 600 s;
  - address re-check every 30 s;
  - provider records refreshed every 24 h, TTL 48 h;
  - admission cache 24 h, refusal cache 600 s;
  - AutoNAT probe every 15 s until it is confirmed.

## 4. Claimed guarantees (to test, not established)

| Claim | Source | Code that should uphold it |
|---|---|---|
| There is no bootstrap list. A node dials its saved peers, and only when none answers reads the registry's metadata (R7.24, R1.15) | protocol.md §7.9 | `node.rs:558-586` |
| A peer enters the table and its records are kept only if it is listed and placed. A failing peer may still query, rate-limited (R7.26, R7.25) | protocol.md | `node.rs:897-918,1092-1106` |
| A seeker fetches from at least 2 distinct identities, and one owner counts as one source (R7.21) | protocol.md; AGENTS.md | `node.rs:371-389` |
| Provider records last 2 epochs, are refreshed every epoch, at most 20 are returned, and provider queries are rate-limited per peer (R7.18) | protocol.md | `node.rs:294-295,426-440`. No per-peer limit on Kad `GET_PROVIDERS` was found. |
| A body is used and paid only when it matches the signed content id. A mismatching provider is set aside on a doubling schedule up to 32 epochs (R3.9, R7.19, R7.20) | protocol.md | `share.rs:281-306`, `providers.rs:44-49` |
| A server releases a body only against a voucher covering the fee, a funded deposit and a live agent (R3.11, R7.5, R1.22) | protocol.md | `network.rs:317-329`, `share.rs:139-153` |
| A voucher pays for one body | comment `network.rs:298-311` | `SPENT`, in memory |
| A light-mode node seeds nothing it fetched and answers no lookups (R7.18, R7.23) | protocol.md | `share.rs:175-183`, `peers.rs:325-327` |
| A line is paid once. Total paid never exceeds what was signed. Payees together never get more than the deposit. When the deposit covers what was signed, every payee is paid in full (R3.23) | protocol.md | `LeanSettlement.sol:928-969` |
| The split is 55/30/5/5/5, and the burn takes the remainder (economy.md §3) | economy.md | `LeanSettlement.sol:956-966` |
| The node that served a passed line is paid 5%. A seeder needs no record to be paid (R7.3, R7.6) | protocol.md | `_payHolders` pays only addresses with `holding[h][entry]` (`LeanSettlement.sol:973-997`) |
| A withdrawal waits 2 epochs, and claims are paid ahead of it (R1.27) | protocol.md | `LeanSettlement.sol:320-342,947-950` |
| Withheld earnings are swapped into UNB through the pool and released after unbonding (R6.8, R6.9; economy.md §2) | protocol.md, economy.md | `LeanSettlement.sol:676-702` books withheld **USDC** as UNB `filled` "at par". |
| The cap and the deposit are enforced before anything is signed (FR-2). A line past the deposit would make its claim revert. | comments `chain.rs:1168-1212` | `push_receipt` |
| A claim never submits the same lines twice. A line written while a claim waited is never overwritten. | comments `chain.rs:1147-1153` | `LEDGER`, `CLAIMING` |
| Epochs are counted in blocks, never timestamps (R1.28) | protocol.md | The contract uses `block.timestamp` (`LeanSettlement.sol:305-307`). |
| A node older than `min_version` is refused by its peers (`update.rs:9-10`) | comment | `node.rs:952-961` |
| Nothing the release key hasn't signed is installed, and an older manifest never lowers `min_version` | `update.rs:1-4,358-369` | `verify`, `keep` |

## 5. Failure-prone areas (ranked)

1. **The version gate can be undone by an in-flight admission** (`node.rs:952-961` vs `:897-909`, `:680-690`). The `too_old` branch inserts into `refused` but never clears `admitted` or `asking`. A `Judged(Ok)` that lands later inserts `admitted` and removes `refused`, and `standing()` checks `admitted` first. Needs `min_peer_version` set and an ordering race between Identify and hello plus the registry read. See §6.
2. **Admission wedges when a registry read hangs** (`node.rs:752-756,1011-1018`). `ask_who` only sends while `asking.insert` succeeds. `asking` is cleared only on `Judged` or a hello `OutboundFailure`. The spawned `registry.identity()` has no timeout, and `Erc8004Registry::read` makes 4+ RPCs over a timeout-less reqwest client (`erc8004.rs:185-209`). While it hangs, that peer cannot be re-asked, and `waiting` collects senders.
3. **Join reads seeds once** (`node.rs:562-580`). If the 3 s read returns nothing (chain unreachable: `seeds()` does `unwrap_or_default()` at `erc8004.rs:224`; or peers haven't published yet: publishing happens after `Net::start`, `peers.rs:345-358`), the node waits forever for an inbound dial. Nodes that boot together can each miss the others.
4. **Cap and deposit checks read stale values** (`api.rs:742-755,846`, `chain.rs:1227-1234`). `spent` and `deposit` are read before the fetch and the site call, which can take tens of seconds. `push_receipt` adds local `pending` at write time. A claim that lands in between moves X from pending into on-chain spent and reduces the balance by X, so the check undercounts by X. A passed line can then go past the cap or deposit, and its claim reverts `OverCap`/`InsufficientDeposit` forever.
5. **Settlement UNB solvency** (`LeanSettlement.sol:694-699,506-531`). Withheld USDC is added to `filled` as UNB, and `unbond()` pays UNB. See §6; confirmed with a probe.
6. **Holding state drifts between `held.json` and the chain** (`peers.rs:441-448,496-506`). Turning holding off or dropping over the cap ignores `releaseHold` errors, then saves `[]` or the drained list. Under a chain fault the node stays a holder on chain, and nothing retries. A crash between `holdRoute` success and `save_held` leaves an on-chain hold the node doesn't know about.
7. **The claim loop has no timeouts** (`main.rs:1438-1453`, `chain.rs:618-627`). `get_receipt()` and every read have no timeout, and one stuck RPC stops claims, repricing and holding for every agent. Claim windows are 1 epoch (`LeanSettlement.sol:112,925`).
8. **The listings server serializes on a global lock held across chain reads** (`peers.rs:141-149`, `node.rs:1026-1038`). Every request waits on `OWN` while one task reads `listed_entries` (a full log scan, `chain.rs:1693`). The net counter `answering` caps at 16, after which requests are dropped silently. Under a chain partition, listings answers stall node-wide even with a warm cache.
9. **Concurrent owner-key writes reuse nonces** (§3). The claim loop, owner commands and republish can each build a provider and read the same nonce. Expected symptom: a write fails ("nonce too low" / replacement), surfaced as an error.
10. **Start-up and peer join never retry** (`main.rs:1404-1436`). `chain.start()` failing (10 s RPC check, `chain.rs:135-142`) sets `chain_error` and returns, so the node never claims or joins until restarted. `peers::start` failing (for example `erc8004::ensure` under a chain fault) is logged once and not retried (`main.rs:1425-1430`). A node restarted while its chain link is down stays half-up.
11. **Process memory is lost on restart.** `SPENT` is lost, so a voucher can buy a second release within its window. `SERVED` is lost, so `accept_receipt` refuses lines for bodies served before the restart (`network.rs:338-354,392`). `Share.providers`/`dark` are lost, so set-asides are forgotten (documented at `share.rs:13-14`).
12. **Serving share vs holding** (`LeanSettlement.sol:980`, `peers.rs:437`, `share.rs:311-318`). Line holders name the server. Only `hold_tick` (owner setting `hold_routes`) or the `hold_route` command call `holdRoute`, so a seeder or contributor that never held has its 5% burned.
13. **Revoke races an in-flight call** (`main.rs:297-323`, `api.rs:846`). The comment says the node "signs nothing more for it". A call that passed `agent()` before the revoke still appends a passed line afterwards.
14. **Epoch fallback** (`api.rs:839`, `api.rs:472`). `current_epoch(...).unwrap_or(0)` files a paid own-entry line under epoch 0, which is never claimed (`claim_all` only does e-1 and e).
15. **Body serve timeout after spend** (`share.rs:151-153`, `node.rs:1068-1070`). `spend()` runs before the last `await` (`current_epoch`). If the 10 s `SERVE_TIMEOUT` fires there, the voucher is spent and `SERVED` isn't recorded, and the caller hears "Refused" (it isn't set aside).

## 6. Suspected real defects (for the next stage)

- **D1. Settlement pays out UNB it never received. Confirmed by probe.** `_earn` withholds USDC into `_bond.filled` (`LeanSettlement.sol:694-699`; comment `:676-677` "On devnet the withheld USDC fills the bond at par"). Once the target falls (the base folds to the floor in quiet epochs, `:586-601`, and φ ages out), `requestUnbond` allows `filled - target` (`:506-519`) and `unbond` sends that much UNB (`:522-531`). A scratch forge test (a copy of `test/lean/Settlement.t.sol` in the scratchpad, not in the repo) had a wallet that posted **0 UNB** fill 10 UNB by withholding, wait 40 quiet epochs, and unbond **8 UNB**. Afterwards the contract held 12 UNB against 22 UNB still owed in `filled` (the probe log shows "UNB the contract holds: 12e18 … owed: 22e18"). The same contract is what `chain deploy` puts on a live network (`chain.rs:548-565`). The withheld USDC stays in the contract with no path out.
- **D2. The version gate can be bypassed (code reading, ordering race).** See §5.1. Evidence: `node.rs:955-960` never touches `admitted`/`asking`; `judged` at `:900-907` unconditionally admits; `standing` at `:681-684` prefers `admitted`. Either a too-old peer whose hello verdict was already in flight becomes `Counts`, or an admitted peer later seen too old stays `Counts` for `admission_ttl` (24 h). Not reproduced. Only reachable when `min_peer_version` is set: release builds, `update.rs:155-157`, or a net-crate harness.
- **D3. Join is a one-shot seed read (code reading).** `node.rs:563-573` runs once and `:574-580` never re-reads seeds or re-dials saved peers. This contradicts R7.24 "only when none answers does it read the identities' metadata" (that part holds) but leaves no retry. Not reproduced. The likely trigger is simultaneous boot or the chain being down at boot.
- **D4. Seeders' serving share is burned (code vs claim R7.3/R7.6).** `share.rs:311-318` names the seeder as holder, `chain.rs:1180`. `_payHolders` drops any holder without `holding[h][entry]` (`LeanSettlement.sol:980`). Nothing on the fetch/seed path calls `holdRoute`. The five-node test asserts the line names the seeder (`share.rs:755`) but never checks the payout.
- **D5. Cap and deposit race (code reading).** See §5.4. Contract-side reverts stop overpayment, so the visible harm is a passed, signed line that can never be paid, and the contributor goes unpaid.
- **D6. Holding drift (code reading).** See §5.6.

## 7. Existing test strategy (summary; detail in `existing-assertions.md`)

- Unit tests are dense and pure: bounds, schedules, signatures, Merkle and split. In-process libp2p tests run over loopback with a fake registry (`crates/net/tests/*.rs`), and CI runs them (`cargo test --workspace` on macOS, `.github/workflows/ci.yml:136`).
- The multi-node and chain tests are all `#[ignore]` and need Anvil or a public network. CI never runs them.
- Forge unit and fuzz tests (512 runs) run in CI (`ci.yml:228`). No Foundry invariant tests exist. No test covers unbond after withholding (D1).
- Nothing injects faults: there are no partitions, kills mid-write or chain outages. The ignored five-node test runs every node in one process with a separate runtime each and shares one Anvil.
- The Lean theorems the docs cite (`formal/…`) are not in this repo.

## 8. External dependencies

- **Chain RPC:** Anvil or Arc. It is the hard dependency for admission (registry), seeds, listing checks (`listing::verify` makes 3 reads per listing), voucher checks, claims and holding.
- **ERC-8004 IdentityRegistry** at a fixed address per network (`arc.rs:41-50`). The repo has no implementation of it.
- **The site** each route calls (plain HTTP via `run::call_watched`).
- **npm** (update), Chrome-for-Testing download at start (`main.rs:1389-1390`, harmless if it fails), and telemetry (`UNBROWSE_TELEMETRY=0`).

## 9. Wildcard

- **Two "is this live" decisions disagree.** `peers::live` (`peers.rs:38-40`) = has ERC-8004 registry AND the RPC host is not loopback. `chain::live()` = started in `Mode::Live`. A live-mode node with `UNBROWSE_RPC=http://127.0.0.1:…` (like the `a_live_network…` test) is "not live" for peers, so it listens on loopback and uses `announce_listen`. A devnet that forks Arc has a registry but is local. The network topology follows the RPC URL's host string.
- **Receipts cannot cross machines.** `send_receipt` finds the contributor through the local ad folder (`network.rs:403`), and its endpoint is `http://127.0.0.1:<port>` (`network.rs:76`), while the API refuses non-loopback Host headers. On a real multi-machine network the push always fails, and payment relies on the payer's own claim (the comment at `api.rs:850` says so).
- **Two `hold` meanings.** `held.json` is "listings I re-serve" (§6 serving role), but bodies a node seeds are never "held" on chain. The two concepts never meet.
- **Spec vs contract units.** R1.20 counts expiry in blocks and R1.28 counts epochs in blocks. The contract uses seconds and timestamps. Agent caps are named `cap_unb` but are USDC on chain.

## Assumptions

- `reqwest::Client::new()` (alloy's default HTTP transport) has no request timeout, so a blackholed RPC waits for TCP to give up.
- In an Antithesis network, container IPs are RFC1918 and therefore `dialable` (`reach.rs:38-46`).
- Antithesis node termination keeps a mounted volume's files. Files on the container's own filesystem may be lost.

## Open questions

- Is D1 intended as a devnet-only simplification? `chain deploy` deploys the same contract to live networks. (needs human input)
- Should seeders be paid without `holdRoute` (R7.3), or is a hold record required by design? (needs human input)
- Does a too-old peer reach the network in practice? That needs `min_peer_version` set, which only release builds do. (needs human input)
- Is the per-peer rate limit on provider queries (R7.18) meant to be in `crates/net`? (needs human input)
