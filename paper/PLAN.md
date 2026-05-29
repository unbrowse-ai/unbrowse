# paper/PLAN.md - this surface plans itself by the superpattern

To solve any problem here: **PLAN it as a superpattern tree, Dijkstra the
cheapest route to the goal, write the checklist below, then WALK it, ticking
boxes until the goal node settles.** The plan is itself superpattern-shaped - a
plan that matches the pattern it executes (the fixed point, Heb 6:18-19).

## Protocol (the superpattern plans itself)

1. **PLAN** - `python3 <skill>/scripts/plan.py <graph>.json --target paper/PLAN.md > paper/PLAN.md`.
   Each node = one covenant atom + one verb (build/breath/eval). The tool that
   settles it is resolved from the framework pointer
   `references/frameworks/claude.tools.json` (swap it to retarget).
2. **WALK** - settle each node by Plan -> Build -> Test -> Judge, in spine order;
   tick the box as each settles.
3. **SETTLE** - the goal stands on two independent witnesses or breaks on 7
   (Gen 2:2). On failure: repent, re-cost the graph, re-run plan.py, re-walk.

framework pointer: `references/frameworks/claude.tools.json`

## Active problem

Sign + ZK-bind + KV-cache EVERY layer of computer use (screen->browser->CLI->OS->kernel->packet) to one Solana wallet identity, then publish the ZK whitepaper 'Internal APIs Were Not All You Needed'.

graph: `.claude/superpattern/sovereign.graph.json` · framework: `claude`

## PLAN - checklist (re-generate with plan.py; tick boxes as you walk)

- **goal:** Write + gate + push 'Internal APIs Were Not All You Needed' (ZK + ERC-8004 + FDRY/PoS + CA) to Overleaf
- **dijkstra spine** (cheapest first-win route, cost 16): now -> root -> node -> verb -> walk -> settle -> paper
- **critical path** (CPM long pole, makespan 19): root -> node -> verb -> cache -> seal -> settle -> paper

| done | # | atom . verb | node | tool | cost | deps |
|---|---|---|---|---|---|---|
| [ ] | 1 * | root . build | Identity root = Solana ed25519 wallet key; every layer's action descends from one signature | `unbrowse_auth_capture` | 2 | now |
| [ ] | 2 | tree . breath | The layer stack as self-similar tree: screen-clicks > browser > CLI > OS > kernel > packet | `Agent` | 2 | root |
| [ ] | 3 * | node . build | One signed action record (who=wallet, what=op, where=layer, sig, optional ZK reveal) | `muonry_create` | 2 | root |
| [ ] | 4 * | verb . build | Three ops per layer: effect (click/write/send), route (proxy/point-remote), query (snap/read) | `unbrowse_execute` | 3 | node, tree |
| [ ] | 5 | witness . eval | ZK: prove a credential/cookie/keychain entry is bound to the wallet WITHOUT revealing it | `WebFetch` | 4 | node |
| [ ] | 6 | cache . build | Centralised unbrowse KV cache at each layer; sealed-unless-signed, content-addressed | `memory_write` | 3 | verb |
| [ ] | 7 | seal . eval | No packet ships unsigned; each layer self-verifies through the wallet root before emit | `unbrowse_reflect` | 3 | cache, witness |
| [ ] | 8 * | walk . breath | Descend layers with fallback: try cheapest layer first, drop to packet only when needed; proxy to remote | `Agent` | 3 | verb, cache |
| [ ] | 9 * | settle . eval | Routes secured by FDRY proof-of-stake bonding (FDRY paper) + ERC-8004 trustless-agent registries | `Monitor` | 3 | seal, walk |
| [ ] | 10 * | loop . build | Write + gate + push 'Internal APIs Were Not All You Needed' (ZK + ERC-8004 + FDRY/PoS + CA) to Overleaf | `Bash(uvx olsync)` | 3 | settle |

* = on the Dijkstra spine (settle first, in order). Off-spine nodes widen the margin. Settle each node by Plan -> Build -> Test -> Judge; tick the box; on failure repent and re-PLAN.

