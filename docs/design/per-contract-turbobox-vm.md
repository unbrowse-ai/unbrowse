# Per-contract turbobox VM bound by lineage

**Status**: design, not deployed. Awaits Lewis approval before any provisioning.

## Why this exists (Lewis 2026-05-25)

> each contract deserves their own remote vm / turbobox bound to their name
> when remoted in - secured by the same peer-peer network tied to the parent
> identity lineage secured

Today a contract is a row in the ledger. It declares a truth claim and a
typed graph of synapses, but it has **no body** — no place to run code, no
filesystem, no daemon. When a contract needs to fire its action, the
substrate either runs it locally (CLI pointer) OR hands it to the cloud
substrate's stateless LLM compiler.

A contract's body should be its own ephemeral VM — a turbobox bound to
the contract id, addressable only via the lineage chain. Reality parallel:
**a neuron has a cell body (soma), not just an identity. The soma is where
the cell's metabolism lives.**

## Public shape — same, no new verb

The agent still only types:

```bash
aiko "<goal>" --remote
```

When the substrate spawns the contract, if its action requires execution
beyond the LLM-compiler's stateless shape, the substrate provisions a
turbobox keyed by the contract id. The turbobox is invisible to the caller
unless they explicitly query for it.

## Identity = contract id + ed25519 lineage signature

Each VM's network identity:

- **Name**: `aiko-<contract-id>.turbobox.unbrowse.ai` (e.g. `aiko-a26de92f.turbobox.unbrowse.ai`)
- **Pubkey**: the contract row's `env_pubkey` (deterministic ed25519 derivation from root + contract id, per existing lineage scheme)
- **Network ACL**: WireGuard mesh; only peers whose pubkey appears on the
  contract's lineage chain (parent_id walk → ancestor `env_pubkey`s
  + descendants reachable via `contract:<id>` synapses) can dial

This means the turbobox is **default-unreachable** to the open internet.
No public IP, no DNS-resolvable hostname outside the mesh, no firewall hole
to bypass. The lineage IS the access list.

## Reality parallel — synaptic specificity (again)

Same shape as the read-visibility fix in #796 (lineage-bound row reads).
Outside the synapse graph, the neuron is dark. We now extend "dark" from
*just the row content* to *the compute substrate the row hosts*.

| Domain | Mechanic |
|---|---|
| Mycorrhizal network | trees exchange nutrients via fungal threads; species not bonded can't tap |
| Cell membrane | cytoplasm is opaque; only typed receptors cross the boundary |
| **Per-contract VM** | turbobox is opaque; only lineage-mesh peers can dial |

## Provisioning pipeline

```
1. aiko "<goal>" --remote  → substrate writes declared row, computes env_pubkey
2. substrate inspects row.action:
     - "neuron" (default pure-LLM)         → no VM
     - "cli"/"http"/"long-running"/"daemon" → spawn turbobox
3. for spawn: substrate emits posthook to turbobox-provisioner contract,
   which:
     a. allocates a CF Container instance (or fly.io machine, hetzner CX)
     b. installs the WireGuard config pre-keyed with env_pubkey
     c. registers the mesh route in the lineage ACL store
     d. writes an iterated row: { action_result: "turbobox-ready",
                                  endpoint: "10.42.x.y:443" }
4. caller learns the turbobox endpoint by reading status — only succeeds if
   caller's wallet pubkey is on the lineage chain (per #796)
5. caller dials over the mesh; WireGuard rejects non-lineage peers
```

## What runs INSIDE the turbobox

A minimal substrate image:

- `aiko` binary (so the VM can declare child contracts in its own context)
- `unbrowse` binary (so it can browse the web on behalf of the contract)
- Kuri (for browser sessions)
- The contract's declared `action` script
- A small SDK that exposes `/v1/exec` over the mesh — peers POST a typed
  request, the VM runs it, returns the response

## Termination + GC

Three lifecycle paths:

1. **Satisfied** → the substrate appends a `satisfied` row → posthook to
   turbobox-deprovisioner → VM terminated, WireGuard route revoked,
   storage zero'd
2. **Dead** (TTL exceeded with no iterated rows in N hours) → same
   deprovision posthook
3. **Explicit `aiko <contract-id> --teardown`** (not a new verb — same
   shape, the substrate recognizes the teardown intent in the plan text)

GC pressure: at 10k active contracts and an average VM cost of $0.005/hr
(CF Containers small tier), that's $50/hr or ~$36k/mo. NOT cheap. Two
mitigations:

- **Lazy spawn**: only provision when the contract's action explicitly
  requires it (default pure-LLM contracts get no VM)
- **Aggressive idle reaper**: VMs without inbound RPC for 10 minutes are
  paused (saved snapshot, freed compute); resume on next dial

## Open questions for Lewis

1. **Container substrate**: CF Containers (newest, smallest cold start, tight CF integration), Fly.io machines (proven, $0.0000022/sec, global anycast), or a Hetzner provisioner (cheapest, but more ops)? Recommend CF Containers as default.
2. **Mesh transport**: WireGuard (simple, but key rotation is manual), Tailscale (rich ACLs, but vendor-bound), or a self-hosted Headscale (free, but ops cost)? Recommend Tailscale with a free tier for v1, migrate to Headscale at 100+ active VMs.
3. **Action types that trigger spawn**: which `action` values get a VM? Initial proposal: only `daemon`, `long-running`, `http-server`, `repl`. Pure `neuron` / `funnel` / `cell` / `sequence` stay VM-less. Want input on the dispatcher table before code lands.
4. **Cross-lineage replication payment** (existing `replicated_from_contract_id`) — does paying for a replica also clone the VM, or does the replica get its OWN fresh VM? Recommend fresh VM (provenance + payment is per-VM-instance, not per-row).
5. **Per-tenant turbobox isolation** — when contract A's VM is dialed by contract B (descendant), is the request authenticated as A's wallet or B's? Recommend dual: the request carries B's wallet but executes WITHIN A's lineage context (typed `X-Lineage-As-Of: <A's id>` header).

## Estimated lift

- Provisioner contract (TS, runs on backend): ~300 LOC to wrap CF Containers API + WireGuard key derivation + lineage ACL store + lifecycle posthooks
- Turbobox image (Dockerfile + entrypoint): ~50 LOC + build pipeline
- libcontract (Zig): ~40 LOC for the new `action` dispatch arm
- Mesh ACL store (CF KV): trivial — write on declare, delete on satisfy/dead
- Tests: ~120 LOC (spawn-on-action, non-lineage-peer-rejected, idle-reaper)

Total: ~550 LOC + container infra. NOT a one-PR ship; this is a 1-2 day build with real $$$ at stake (per-VM hourly billing). MUST stay design-only until Lewis approves the substrate choice + cost ceiling.

## Why this matters strategically

The substrate today is "stateless cloud LLM + local CLI". Adding per-
contract VMs makes it "stateless cloud LLM + lineage-bound mesh of typed
remote substrates". That's the difference between:

- **"AI agents run prompts"** (today)
- **"AI agents inhabit lineage-bound machines"** (after this lands)

The marketing line: *every contract gets a body. Every body has a name.
Every name resolves only inside the synapse graph it was born into.*
