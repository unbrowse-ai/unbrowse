# Release strategy — staged reveal, stable on main

The reveal is progressive, hidden in branches; only the stable line ever touches
the public repo. The gate proves stable before it syncs.

## The line (Dijkstra-cheapest reveal order)

```
stable (main, public)  →  release/zk-auth  →  release/maintenance-network
   the drop-in wedge        Paper 2: auth         Paper 3: trust economy
   (public today)           with ZK (hidden)      (hidden, revealed last)
```

- **main = stable.** The public drop-in-replacement surface: the covenant route as
  a drop-in for Agent Skills / MCP tools / x402 Bazaar resources, the x402 payment
  rail, resolve, ranking, the publish gate. This is what syncs to the public repo
  (`unbrowse-ai/unbrowse`, default branch `stable`, MIT-frozen by design).
- **release/zk-auth** (hidden). Paper 2's security descent: ZK credential binding,
  uniform signed descent. Built on its own branch, revealed after stable lands.
- **release/maintenance-network** (hidden). Paper 3's trust economy: proof of
  indexing, bonded challenge/slash, Merkle checkpoints, the 6h refresh loop,
  sealed-unless-revealed cache (`src/trust/`). Revealed last.

## The remote model (pointer, not active sync)

No active main→public copy pipeline. Each line is a branch on a remote; "public"
is just a **pointer to the stable branch**, advanced deliberately when the gate is
green — never a background job that could leak an unrevealed branch.

- **Core / canonical home:** the self-hosted **gitea-mirror** (`gitea` remote) —
  `main` (stable) lives here as the source of truth for unbrowse core.
- **Dev:** `github-ssh` (`unbrowse-ai/unbrowse-dev`, private) — all branches,
  including the hidden reveals.
- **Public:** `unbrowse-ai/unbrowse` (frozen `stable`) — a pointer to the stable
  branch only. Advanced by the author, gate-green, not by automation.
- **Reveal branches** (`release/zk-auth`, `release/maintenance-network`) live as
  branch remotes; never pointed-to by public until their reveal.

`scripts/leak-guard.sh` is the mechanical boundary (no economic constant, capture/RE
internal, or operator surface in any public artifact) under the human staged-reveal
boundary on top.

## Prove stable before sync (the seal — no fabricated green)

```bash
bash scripts/stable-release-gate.sh   # exit 0 == safe to be the stable release
```

Runs the stable-surface test suite (drop-in + x402 + resolve + ranking + publish),
`leak-guard.sh`, and `paper-gate.sh` on both papers. Exit 0 is the precondition for
any stable → public sync. A red gate is a held release, never a forced one.

## Status

- [x] Stable gate built + green (`scripts/stable-release-gate.sh`).
- [x] `release/maintenance-network` holds the trust-economy reveal (`src/trust/`).
- [ ] `release/zk-auth` — created when the ZK auth work begins (Paper 2).
- [ ] Public sync of `main` — held; performed deliberately, gate-green, by the author.
