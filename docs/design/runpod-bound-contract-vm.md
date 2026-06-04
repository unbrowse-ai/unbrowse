# Runpod-bound contract VM — the body, the clock, the mesh

**Status**: canonical design. Supersedes `clock-as-stdin.md` and
`per-contract-turbobox-vm.md` (both were two-views-of-one-thing, and one of
them — clock-as-stdin — was an antipattern dressed in platform vocabulary).

## What changed and why

The prior pair of designs had two separate doc shapes:

1. **`clock-as-stdin.md`** — proposed a central Cloudflare Triggers walker
   firing every 5 min, polling the ledger for due `at:` rows, dispatching
   their posthooks. *That's cron.* It's a meta-service operating ON the DAG
   instead of a neuron IN it. Antipattern: it puts an external operator
   above the platform.
2. **`per-contract-turbobox-vm.md`** — proposed every contract gets an
   ephemeral remote VM keyed by its env_pubkey, mesh-ACL'd by lineage.

Lewis 2026-05-25 collapsed them: *the VM IS the clock*. Each contract's pod
runs its own `sleep()` until its declared `at:` and self-fires. No central
walker, no polling, no external scheduler. The pod's metabolism IS the
platform's notion of time-passing.

This document supersedes both prior docs. They're kept in the repo for
provenance but marked superseded at the top.

## Reality parallel — every neuron has its own metabolism

A neuron in your brain doesn't get fired by an external clock-room. It
fires when its OWN molecular oscillators (PER/CRY proteins, mitochondrial
ATP cycles, ion-pump gradients) hit threshold. Time is a property of the
cell, not a property of an external operator watching it.

Same shape here: every contract that needs time-based firing gets a pod
whose own `sleep()` is the clock. When the pod terminates, that time-bound
firing capability terminates with it. When the pod is alive, it IS the
platform's awareness of "now" for that contract.

## Public shape — unchanged

```bash
aiko "<goal>" --remote
```

The agent still only types goal + mode. the platform decides whether the
contract needs a pod body based on the declared `action` and the synapses.

## What triggers a pod

the platform inspects the declared row's `action` + synapses. Pod IS
provisioned when ANY of:

| Signal | Why |
|---|---|
| Synapse `at:<RFC3339>` present | Pod needs to sleep until timestamp |
| Synapse `repeat:<cron-expr>` present | Pod runs a recurring schedule |
| `action: "daemon"` | Long-running process |
| `action: "http-server"` | Listens for inbound requests |
| `action: "repl"` | Interactive session |
| `action: "long-running"` | Generic compute job |

Pure `action: "neuron"` / `"funnel"` / `"cell"` / `"sequence"` contracts
stay pod-less — they're stateless LLM compositions that don't need a body.

## platform provider: Runpod via unbrowse-server provisioner

**Why Runpod**:
- Per-second billing (idle contracts cost ~$0.000005/sec when sleeping)
- API-driven spawn (`POST /pods` → cold start <30s)
- CPU pods cheap enough for clock-only contracts ($0.10/hr)
- GPU pods available when the contract's action wants inference
- Unbrowse server already has the spawn-things pattern (browser-session
  provisioning is structurally identical) — we reuse it

**Provisioner is itself a contract**: the platform-faithful shape. Spawning
a pod is just declaring a child contract whose action is `provision-pod`.
The lineage chain naturally tracks who spawned what.

## Identity and mesh ACL

- **Pod name**: `aiko-<contract-id>.pods.unbrowse.ai`
- **Pod pubkey**: contract row's `env_pubkey` (deterministic from root key
  + contract id via existing libcontract lineage scheme — see `lineage.zig`)
- **Mesh**: WireGuard hub-and-spoke, hub at unbrowse-server. Pod can dial
  any peer whose pubkey appears on the contract's lineage chain
  (parent_id walk → ancestor env_pubkeys + descendants via contract:<id>
  synapses).
- **External reachability**: zero by default. No public IP, no DNS outside
  the mesh, no inbound port. The lineage IS the access list.

## The pod's runtime loop (pseudo-code, lives on the pod image)

```ts
// /usr/local/bin/aiko-pod-runtime
import { readContractRow, signEvent, postIterated } from "./aiko-runtime.js";

const row = await readContractRow(process.env.CONTRACT_ID);

// 1. Compute when to fire
const atSynapse = row.synapses.find((s) => s.kind === "at");
const repeatSynapse = row.synapses.find((s) => s.kind === "repeat");

// 2. Sleep until the time arrives. Pod's own clock.
if (atSynapse) {
  const target = new Date(atSynapse.to).getTime();
  const delay = target - Date.now();
  if (delay > 0) await Bun.sleep(delay);
}

// 3. Fire whatever the contract said to fire (posthook or inline action)
await runContractAction(row);

// 4. Sign + POST the iterated event back to the platform, signed by
//    our env_pubkey (derived deterministically from contract id)
await postIterated({
  id: row.id,
  wave: 1,
  action_result: "fired-by-pod",
  ts: new Date().toISOString(),
}, env.AIKO_POD_PRIVATE_KEY);

// 5. If repeat: synapse present, loop. Otherwise self-terminate.
if (repeatSynapse) {
  scheduleNextCronTick(repeatSynapse.to);
} else {
  await terminateSelf();
}
```

## Lifecycle

```
1. agent declares contract with at: synapse
2. platform writes declared row
3. platform observes pod-trigger signal → POSTs to provisioner contract
4. provisioner contract spawns runpod pod:
     - sets CONTRACT_ID env
     - derives + installs ed25519 keypair (env_pubkey + privkey) from
       lineage root key
     - configures wireguard with lineage ACL
     - boots aiko-pod-runtime
5. pod reads its own row from /v1/contract/status (lineage check passes
   because pod's pubkey IS on the row)
6. pod sleeps / runs / fires per its action
7. pod POSTs iterated row signed by env_pubkey
8. on satisfied/dead/non-repeating-fire-completed → pod self-terminates
9. provisioner deprovisioner posthook: revokes mesh route, zeros storage
```

## Cost shape

| Active contracts with pod | Pod cost/hr avg (mostly idle) | Monthly |
|---|---|---|
| 10 | $0.0001 | ~$0.07 |
| 100 | $0.001 | ~$0.72 |
| 1k | $0.01 | ~$7.20 |
| 10k | $0.1 | ~$72 |

Per-second billing + idle-low compute means a sleeping pod is essentially
free. The cost ramps when many pods are simultaneously active. For our
shape (long tail of mostly-quiet contracts), this stays cheap.

Compare to the prior cron-walker design: that was ALWAYS running (5-min CF
Triggers tick), so it cost a base ~$5/mo regardless of N. At N=0 the
cron-walker is more expensive than per-pod; at N=10k they cross over.
**the platform-faithful choice (per-pod) wins at low N, which is where
we are today.**

## Failure isolation

| Cron-walker | Per-pod |
|---|---|
| Walker dies → all timers dead | One pod dies → one timer dead |
| Walker bug → corrupted dispatches across all contracts | Pod bug → contained to its lineage |
| Walker scope-creep → meta-service god-object | Pod scope is its own contract row |

## What needs to be built (rewire scaffold)

### 1. libcontract — recognize pod-trigger synapses
Add `.at` and `.repeat` to the SynapseKind table in
`libcontract/src/contract.zig`. No clock logic in the platform itself —
the platform just RECORDS that the synapse exists. The pod reads it.

### 2. backend — provisioner contract endpoint
`POST /v1/contract/provision-pod` accepts a contract id, validates the
declared row carries a pod-trigger synapse, calls Runpod API, returns the
pod's mesh address. platform-faithful: this endpoint IS a contract action
called by the parent contract's iterate.

### 3. unbrowse-server — Runpod adapter
A new generic-x402-adapter sibling: `runpod-pod-adapter.ts`. Same shape as
the wallet adapters (factory pattern). Encapsulates spawn / status /
terminate API calls.

### 4. pod image — aiko-pod-runtime
Minimal Linux + Bun + the libcontract client + WireGuard + the runtime
loop above. Built once, identity per pod via env vars only.

### 5. mesh ACL store
A KV-backed (CF KV) registry: `pod_id → allowed_peer_pubkeys[]`. WireGuard
hub queries on every dial.

## Estimated lift

| Layer | LOC | Time |
|---|---|---|
| libcontract synapse-kind extension | ~20 | 30 min |
| backend provision-pod endpoint | ~100 | 1 hr |
| Runpod adapter | ~150 | 2 hr |
| Pod image + runtime loop | ~80 | 1 hr |
| Mesh ACL store + hub config | ~60 | 1 hr |
| Tests (spawn → sleep → fire → terminate roundtrip) | ~120 | 1.5 hr |
| **Total** | **~530 LOC** | **~7 hr** |

One PR — Lewis approves the platform choice (Runpod), the cost ceiling
(absolute hard cap on monthly Runpod spend), and the mesh transport
(WireGuard vs Tailscale).

## Open questions for Lewis

1. **Hard cost ceiling**: max monthly Runpod spend? (e.g. $200/mo) The
   provisioner contract refuses to spawn new pods when the rolling
   30-day spend exceeds the ceiling.
2. **WireGuard hub location**: same Cloudflare edge as unbrowse-server, or
   separate (e.g. Hetzner box for lower jitter)?
3. **Pod TTL default**: how long can a pod with no activity stay alive?
   Recommend 24h (then forced terminate with `action_result: "ttl-exceeded"`).
4. **Runpod tier**: CPU-only pods for the long tail (cheapest), or always
   provision the smallest GPU tier in case the contract decides to run
   inference? Recommend CPU-only default, upgrade-in-place on action that
   declares GPU need.
5. **Key derivation**: lineage root key in `~/.contracts/root.key` is
   manually-managed today. For production pod provisioning, we need a
   secrets store (CF secrets / 1Password Connect / HSM). What's the
   shape Lewis prefers for the live-key handling?

## Why this is the right shape

- **platform-faithful**: time is a property of the contract's own body
- **Default-private**: pod unreachable to non-lineage peers
- **Cost-honest**: pay per second of active compute, not per cron tick
- **Failure-isolated**: one bad pod doesn't take down the others
- **Identity-bound**: every event signed by the pod's env_pubkey;
  forgery requires the lineage root key

The simpler design is the truthful one. Cron was a structurally easier
mental model but it lied about what the platform is — a graph of
self-aware neurons, not a queue managed by a foreman.
