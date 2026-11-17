# background-pass-completes-after-chain-faults-stop

**Focus:** 3 Failure Recovery, 5 Resource Boundaries, 2 Concurrency. **Confidence:** high that the waits are unbounded, medium on how long they last in Antithesis. **Status:** the no-timeout part is confirmed by scratch probe. The loop stall follows from sequential awaits.

## Property

Within a bounded time T after node-to-chain faults stop, the node's background pass (`claim_all`, then `reprice`, then
`hold_tick`) completes, and the next one starts, whatever the faults did to calls already in flight. The owner's
`claim_now` also returns within T.

## Code paths

- Claim loop `main.rs:1438-1453`: one task, strictly sequential: `claim_all` -> `reprice` -> `hold_tick` -> sleep 60 s.
- Every chain call builds `ProviderBuilder::new().connect_http(url())` (alloy-transport-http 1.8.3
  `reqwest_transport.rs:28`: `Client::new()`). reqwest 0.12.28 defaults: `timeout: None`, `read_timeout: None`,
  `connect_timeout: None` (`async_impl/client.rs:299-314`). TCP keepalive is on (15 s, 15 s × 3), which only ends a
  connection whose peer stops acking while idle.
- Writes: `send!` = `send().await` then `get_receipt().await` (`chain.rs:618-627`). `PendingTransactionConfig::timeout`
  defaults to `None` (alloy-provider `heart.rs:287-294`). A tx accepted but never mined, for example replaced by a
  same-nonce tx (`owner-key-writes-never-share-a-nonce`), waits for good.
- `claim_all` (`main.rs:674-695`): for each agent, epochs e-1 and e: `claim` makes 1 + (unfixed holders) + 2 × (open
  lines) reads + `account` + 1 write. Then `claim_owed`: 1 + 2 × (owed) reads + 1-n writes. Each is awaited one at a
  time.
- `reprice` (`main.rs:587-611`): `current_epoch`, `paid_since` (a log scan plus one `entry()` read per new claim),
  `fee_of`, `market_fee` (**the only call wrapped in a timeout**, 15 s per site, `peers.rs:528`), `setFee`.
- `hold_tick` (`peers.rs:437-514`): `find()` per site (no timeout, 3 chain reads per listing in `listing::verify`),
  then a tx per route.
- `CLAIMING` (`chain.rs:1153`) is a tokio mutex held across `send!`. While a pass is stuck in a claim, the owner's
  `claim_now` (`main.rs:697`) and every `claim_owed` wait on it, and the API request hangs with `IN_FLIGHT` raised.
  That also holds an update hand-over off for up to an hour (`update.rs:386-393`).
- The loop only starts after `peers::start` returns (`main.rs:1425-1430`). A stall in `erc8004::ensure`/`publish`
  at boot (same unbounded waits) holds every claim back too.

## Probe (scratch copy, not the repo)

`life-probe/unbrowse-node/app/src/chain.rs`, test `probe_a_silent_rpc_holds_current_epoch_without_end`: a TCP listener
that accepts and never answers, as the devnet RPC port, and `current_epoch` (the first call of both `claim_all` and
`reprice`) under an outer 45 s timeout:
`current_epoch after 45.003728166s: still waiting (outer 45 s timeout fired)`.
So the node's chain reads have no bound of their own. Keepalive probes are answered by the peer's kernel, so a server
that accepts but never answers holds the call for as long as it stays that way.

## How long a stall lasts under Antithesis faults (reasoning, not measured)

- Partition that drops packets: a new connection's SYN retries give up after about 2 minutes (Linux
  `tcp_syn_retries` = 6). An established request's retransmits give up after about 15 minutes (`tcp_retries2` = 15).
  Each sequential call can cost that, so one pass costs calls × minutes.
- Packets "held until the fault expires then delivered": the stall equals the fault's length.
- Chain container hang: the stall equals the hang.
- A replaced or dropped tx: unbounded.

Claim windows are one epoch (`CLAIM_WINDOW = 1`, `LeanSettlement.sol:112`). `claim_all` visits only e-1 and e, so a
stall that spans the end of e+1 loses e's lines for good. With `singleton_driver_epoch` advancing time, that is
reachable in a run. The window part overlaps `passed-lines-are-claimed-within-their-window` (another focus). This
property is the progress condition underneath it.

## Antithesis angle

Node-to-chain partitions, held packets, chain hang, congestion. Then `ANTITHESIS_STOP_FAULTS` and a deadline. Thread
pausing is not needed.

## Instrumentation (none exists)

- SUT, **missing**: at the end of each claim-loop iteration, `Sometimes("background pass completed after a pass that
  took over 5 minutes")`, with the duration in details. Also `Reachable("background pass completed")`.
- SUT, **missing**: a process-static "last pass finished at" timestamp exposed through an owner command or
  `/v1/whoami`. The workload asserts after a quiet period of Q: `Always(now - last_pass_finished <= Q + 60 s + bound)`.
- Workload, **missing**: during a quiet period, `claim_now` returns within T, `Always`.

## Open questions

- What is the intended bound T? None is stated anywhere. A per-call timeout (`reqwest::Client::builder().timeout`) and
  a receipt timeout (`with_timeout`) both exist in the libraries, so the bound is a design choice.
- Does alloy's heartbeat end `get_receipt` with an error when polling fails repeatedly, or keep waiting? Its behaviour
  decides whether a lost connection during the wait ends in an error (retried next minute) or a hang.
