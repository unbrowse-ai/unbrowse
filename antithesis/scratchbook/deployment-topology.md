---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
external_references:
  - path: <checkout>/papers/protocol.md
    why: The deployment shape it assumes (ERC-8004 identities with libp2p metadata, no bootstrap list, AutoNAT/relay, 2-source lookups) and the fault-sensitive requirements (R7.11-R7.27, R3.9-R3.28).
  - path: <checkout>/papers/economy.md
    why: Which money invariants the chain container must let the workload check (split, withholding, vesting, burn).
  - path: AGENTS.md (repo root)
    why: Network rules that the topology must not bypass (standing read from the registry, one owner is one source).
  - path: CLAUDE.md (repo root)
    why: The fixture site is a test fixture. Its name lives in the workload, never in node code.
---

# Deployment topology for Antithesis

## Summary

Six containers: one chain, three nodes, one fixture site and one workload driver. Each node joins the peer network the way it would on a live network: ERC-8004 identities on a shared chain, every interface, a fixed peer port, and AutoNAT deciding reachability. Devnet mode can't be used. It listens on 127.0.0.1 only (`unbrowse-node/app/src/peers.rs:334-338`), and its registry is a shared folder on one machine (`network.rs:27-62`).

```
                    +----------------------+
                    |  workload (driver)   |
                    |  SDK, test template  |
                    +---+------+------+----+
         JSON-RPC (reads|      | HTTP :7700 (shim -> 127.0.0.1:7788)
         + evm_increase |      +-------------+--------------+
         Time)          |      |             |              |
                        v      v             v              v
 +--------------+   +--------+ +--------+ +--------+   +-----------+
 | chain        |<--| node-1 | | node-2 | | node-3 |-->| site      |
 | anvil :8545  |<--|        |<->      |<->       |   | fixture   |
 | chainid      |   +--------+ +--------+ +--------+   | HTTP JSON |
 | 5042002      |        libp2p :4001 tcp+quic, all-to-all   |
 +--------------+        each node -> chain (RPC), -> site (route calls)
```

## Why live mode, and what that requires

A node runs the cross-machine code path only when `peers::live()` is true, that is, when the chain id has an ERC-8004 registry and the RPC host is not loopback (`peers.rs:38-40`, `chain.rs:509-511`). The repo already runs this mode against a local Anvil in `a_live_network_runs_on_the_contracts_its_file_records` (`chain.rs:1866-1956`): `anvil --chain-id 5042002 --base-fee 20000000000`, `UNBROWSE_CHAIN=arc-testnet`, `UNBROWSE_RPC=<anvil>`. With RPC host `chain` (not loopback), `live()` is true. Three gaps must be filled by setup, not by source changes:

1. **An ERC-8004 IdentityRegistry stand-in** at arc-testnet's address `0x8004A818BFB912233c491871b3d84c89A494BD9e` (`arc.rs:46`). The repo has no implementation. Without it, `erc8004::ensure` errors ("no ERC-8004 registry", `erc8004.rs:82-84`) and `peers::start` fails (`peers.rs:315-321`). Write a small Solidity contract under `antithesis/`. It needs:
   - the ABI of `erc8004.rs:23-35`: `register` (returns an id and emits `Registered(uint256 indexed, string, address indexed)`), `setMetadata` (owner only; emits `MetadataSet(uint256 indexed, string indexed, string, bytes)`, whose topic2 must equal `keccak256(key)`, as `seeds()` filters on, `erc8004.rs:220-223`), `getMetadata`, `tokenURI`, `setAgentURI` and `ownerOf`;
   - storage valid at zero, because `anvil_setCode` runs no constructor. Start ids at 1.
2. **Settlement deployed before any node starts.** `start_live` reads `networks/arc-testnet.json` and checks code at the recorded address once (`chain.rs:390-412`). A node that starts first runs without Settlement and never re-checks (`main.rs:1404-1436`). Deploy USDC, UNB and LeanSettlement from a fixed setup key, using `script/DeployLean.s.sol` (same constructor values as `chain.rs:532`). CREATE addresses are fixed by deployer and nonce, so the network file can be baked into the node image. Record `code: ""`: "a deployment that records no code was written by hand" is accepted (`chain.rs:196-199`).
3. **Funded owners.** On a live network only UNB's deployer can mint (`chain.rs:844-859`), and gas is real (`chain.rs:584-592`). Give each node a fixed recovery phrase (`unbrowse-node wallet restore`, 12 or 24 words on stdin, `main.rs:419-442`), so its owner address is known. Setup then calls `anvil_setBalance` and uses the faucet calls to send USDC and UNB to each owner.

## Containers

| Container | Image | Role | Runs | Talks to | Replicas |
|---|---|---|---|---|---|
| `chain` | `ghcr.io/foundry-rs/foundry` + a setup script | dependency | `anvil --host 0.0.0.0 --port 8545 --chain-id 5042002 --base-fee 20000000000 --state /state/anvil.json`. The entrypoint deploys the registry stand-in (`anvil_setCode`), USDC, UNB and Settlement, funds the owners, then reports healthy. | nodes and workload over JSON-RPC | 1 |
| `node-1` … `node-3` | **New** Dockerfile: Rust build of `unbrowse-node` (`cargo build --release -p unbrowse-node-app --bin unbrowse-node`) with Antithesis Rust instrumentation and the `antithesis_sdk` crate. The build needs `unbrowse-node/scripts/apply-tls-patch.sh` (vendored BoringSSL, `ci.yml:120-125`) and the path dependency `unbrowse-browser/core` (`app/Cargo.toml`). The runtime image holds the binary and a shim. | service | `unbrowse-node` (headless, `main.rs:1324`). Also a loopback shim on `0.0.0.0:7700` that forwards to `127.0.0.1:7788`, rewrites `Host` to `127.0.0.1:7788`, and adds the owner token from `/data/owner.token` on `/owner/*`. | each other on libp2p 4001/tcp+udp, `chain:8545`, the site | 3 |
| `site` | Python stdlib or Go, new, about 50 lines | dependency (stand-in for the web) | The JSON shop from `share.rs:551-589`: `GET /api/items?q=` returns one item. `GET /_seen` returns the request lines and `Cookie`s it got, so the workload can check who called. Optional fault knobs (500s, delay) for a custom fault. Reached at a network alias with a public-suffix domain, for example `shop.example.com`: `site_of` rejects IPs and `localhost` (`crates/net/src/site.rs:8-19`). | nodes (inbound only) | 1 |
| `workload` | New. Antithesis SDK (Python or Rust) + `cast` | client | Waits for the chain to be healthy and every node's `/v1/whoami`, creates the agents, seeds roles, then emits `setup_complete`. Test template at `/opt/antithesis/test/v1/unbrowse/`. | node shims, `chain:8545`, `site` | 1 |

### Node image and per-node configuration

- **Environment:**
  - `UNBROWSE_HOME=/data` (a volume, so node termination keeps state);
  - `UNBROWSE_CHAIN=arc-testnet`, `UNBROWSE_RPC=http://chain:8545`;
  - `UNBROWSE_PEER_PORT=4001`;
  - `UNBROWSE_TELEMETRY=0`.
  - Do **not** set `UNBROWSE_ANNOUNCE`. Leaving it unset makes AutoNAT decide Server or Client mode (`node.rs:698-717`, `only_global_ips: false` at `:211`), and a restart may give a new IP (faults.md), which exercises republishing (`peers.rs:361-375`).
- **Build flags:** a release profile **without** `UNBROWSE_RELEASE`. Then `update::enabled()` is false (`update.rs:94-96`), there is no npm traffic, `network_minimum()` is `None` (`update.rs:155-157`), and the root key lives in `/data/root.key` because Linux has no Secret Service (`main.rs:97-104`).
- **Seeded `/data` files:**
  - `settings.json`: `peer_network: true`, `private_network: true` (egress to the site's private IP, `main.rs:1356`), `auto_update: false`, `terms_accepted` (the entrypoint runs `unbrowse-node terms accept`), `api_port: 7788`.
  - `networks/arc-testnet.json`: the baked deployment.
  - `routes/route-items.json` on node-1 only: the route of `share.rs:592-603`, pointed at the site alias.
  - `jars/<host>:<port>.json` on each caller: its own `sid`, as in `share.rs:511-515`.
- **No Chrome.** `browsers::download` fails harmlessly (`browsers.rs:267-290`), and no learn path runs because routes are pre-seeded.
- **Roles, set over the owner API through the shim** (`main.rs:1231-1296`):
  - node-1 is the contributor: `deposit`, `post_bond`, `set_pricing`, `list_route`;
  - node-2 is a caller and seeder, with `hold_routes` toggled by the driver;
  - node-3 is a caller with `light` toggled by the driver.
  - Each caller gets `agent_create` with a cap and a deposit.

### Why each container exists

- **chain**: admission, seeds, listing checks, voucher checks, claims, holds and every money invariant read it. It is one container because the protocol has one chain. Keep it out of node-termination faults, or rely on `--state` on its volume. Anvil's block timestamps follow the container clock, which sets the contract's epoch (`LeanSettlement.sol:305-307`).
- **Three nodes is the minimum** that reaches the interesting states:
  - `checked` needs 2 distinct identities answering a site (`node.rs:387`, R7.21). That takes node-1 plus a holder re-serving its listing (node-2, `peers.rs:154-163`).
  - Seeding and fallback (R7.18, R7.20) need the contributor gone while another node serves. Kill or partition node-1, and node-3 fetches from node-2. This repeats the five-node test's middle act (`share.rs:746-762`).
  - `claim_owed` needs a payer that isn't the contributor.
  - Light mode needs a node that fetches but doesn't seed (node-3).
- **site**: run_route's pass or fail decides whether a line passes and pays. The workload needs a log to check that "the site hears the caller under its own session, and never the serving node" (`share.rs:723-727`). Faults between caller and site produce failed lines.
- **workload**: a single client keeps the template in one place. Node APIs are loopback-only with a Host allowlist (`api.rs:1291,1303-1320`), so the shim inside each node container is what lets one driver reach them. The shim shares the node's fate, which is the right fault model.

### Not included (and why)

- **No relay/NAT container.** Antithesis networks are flat. A node becomes "private" (relay reservations, DCUtR) only if AutoNAT dial-backs fail, which inbound bad-node faults on one node can cause. That makes relay a reachability property under faults, with no extra container. A real NAT box is a later expansion.
- **No adversarial node in v1.** A provider of tampered bodies (`share.rs:605-612`), an unregistered peer, or a too-old peer each needs a code hook (a test-only `Bodies`, `Config.min_peer_version`). Cover those with a separate **net-only harness**: one binary running N `unbrowse_net::Net` with a fake `Registry`, as in `crates/net/tests/network.rs:23-65`, split across 3-4 containers. That is where the version-gate and registry-hang suspects (sut-analysis §5.1-5.2) are cheapest to reach. Its registry can be made to hang on cue.
- **No npm or update path.** The release key is hard-coded (`update.rs:29`), and only `UNBROWSE_RELEASE` builds update. The update and launcher logic (`update.rs:325-369`, `cli.ts:56-68`) is better tested by a unit-level harness calling `update::check(reg, key, …)` with a test key against a local registry, outside this topology.

## Test template sketch (for antithesis-workload)

| Command | Kind | What it does |
|---|---|---|
| `parallel_driver_call` | parallel | An agent on node-2 or node-3: `GET /v1/routes?q=search items on example.com`, then `POST /v1/do` or a network entry call with `pays: true`. Records which entry, which server and whether it was paid. |
| `parallel_driver_owner` | parallel | Random owner actions: `set_pricing`, `delist_route` and `list_route`, toggle `hold_routes` and `light`, `agent_revoke` and `agent_create`, `deposit`, `request_withdraw`, `claim_now`, `save_settings` with `peer_network` off/on. |
| `singleton_driver_epoch` | singleton | `evm_increaseTime` + `evm_mine` (a clock jump, which must move no epoch), then `anvil_mine` on `chain`, crossing epochs while claims are in flight. `advance_day` is refused on live (`chain.rs:1103-1105`), so this is a custom fault. |
| `anytime_contract_invariants` | anytime | eth_call reads: USDC held ≥ Σ balances + escrow + vesting. UNB held ≥ Σ(filled + unbonding) over known wallets (D1). `spentLine` never reverts to false. `_claimed ≤ cap` per (payer, agent, epoch). |
| `anytime_local_vs_chain` | anytime | Each node's `routes_on_chain` and holdings against the chain (the holding-drift suspect, after a quiet period). |
| `eventually_network_formed` | eventually | After a quiet period, every node finds node-1's listing for the site, and the tables are connected. |
| `eventually_lines_settled` | eventually | Every passed line in each caller's receipts is claimed, or its window has closed with a recorded reason. No passed line goes past the cap or deposit (D5). |
| `finally_*` | finally | The same checks after the drivers stop. |

The SUT side needs SDK assertions as well. The places are listed in sut-analysis §5: `judged` and the Identify `too_old` branch (`node.rs:897-961`), `push_receipt` (`chain.rs:1227-1234`), `release` after `spend` (`share.rs:151-153`), the end of `hold_tick` (`peers.rs:505-507`), and `join` seed reads (`node.rs:563-580`).

## Faults each property family needs

| Property family | Faults | Notes |
|---|---|---|
| Joining, admission and lookups (R7.21-R7.26, D3, §5.2) | partitions between nodes; **node→chain partitions and latency** (registry reads); simultaneous boot; node termination (saved `peer-table.json` reload, new IP after restart); node hang | Liveness checks need `ANTITHESIS_STOP_FAULTS` and then a deadline. Termination is often off by default (faults.md), so confirm it is enabled for the tenant. |
| Body fetch, serve and pay (R3.9-R3.12, R7.18-R7.20) | asymmetric loss and held packets between caller and provider beyond 15 s/10 s (`body.rs:34-35`); provider terminated mid-serve; CPU throttling; node→chain partition during voucher checks | Safety (never use or pay for a mismatched body) must hold under every fault. Liveness (some provider serves) holds after a quiet period. |
| Receipts, cap, deposit and claims (R3.22-R3.28, D5, §5.7, §5.14) | **thread pausing and CPU modulation** (call vs claim interleaving); node termination between `send` and `mark` or between the tx and the file write; node→chain partitions (hung `get_receipt`); custom epoch advance; clock jitter on `chain` | Thread pausing needs instrumentation. CPU modulation does not. |
| Holding and listing book (§5.6) | node→chain partition during `hold_tick`; termination between `holdRoute` and `save_held`; between `postRoot` and the book write (`listing.rs:318-319`) | Checked after a quiet period. |
| Contract solvency and split (D1, D4, R3.23) | none needed: on-chain and deterministic | The workload must drive withholding (a contributor without a posted bond), quiet epochs and unbond. It is checked anytime. |
| Restart and in-memory state (§5.11) | node termination with the volume kept | Voucher replay after restart, and lost `SERVED` notes. |

## SDKs

- **Rust:** `antithesis_sdk` in `unbrowse-node` (SUT assertions) plus Antithesis Rust coverage instrumentation of the node binary.
- **Workload:** Python or Rust. Python is simplest with `cast` for chain reads. Solidity needs nothing: the workload checks invariants with eth_calls.

## Assumptions

- `anvil_setCode` with a zero-storage-friendly registry is enough for `erc8004::ensure` and `Erc8004Registry::read`: it needs `Registered` logs in the registration block and `getMetadata` values (`erc8004.rs:185-209`).
- Docker DNS aliases for `site` resolve inside node containers. The node's egress check allows private IPs when `private_network` is on (`main.rs:1356`).
- Antithesis keeps named volumes across node termination.

## Open questions

- Can test commands run inside each node container, which would remove the shim? Or must the template live in `workload`? (needs human input)
- Should the net-only harness run in the same Antithesis run or as a separate test template and topology? (needs human input)
- Can node termination and clock jitter be enabled for the tenant? (needs human input)
- Is a 4th node worth adding later for 3-identity `checked` lookups with one identity partitioned away? (open)
