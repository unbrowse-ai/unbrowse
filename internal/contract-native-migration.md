# unbrowse → /contract-native: the internet-ledger migration (2026-06-22)

**Directive (Lewis):** the whole repo /contract-native — unbrowse DEPENDENT on /contract as
**the internet ledger** (resolve/execute through the signed contract ledger FIRST), with the
**legacy internet** (HTTP/web) as a supported fallback (its original design). Economic loop:
**Faremeter Flex (x402, USDC) wires money → routeRevenue → vault → stFDRY NAV.**

## The honest finding — it is ~70% already native (finish the collapse, not rebuild)

Real surfaces ALREADY in `src/` (the foundation, Matt 5:17 — fulfil):
| Native surface | Role in the internet-ledger |
|---|---|
| `iq-ledger.ts` + `iq-sealed-value.ts` | the ON-CHAIN ledger (IQLabs Solana) — pointers/sealed values |
| `cached-resolution.ts` (peekResolution) | resolution-ledger SHORT-CIRCUIT — replays signed VALUES before the orchestrator boots = **ledger-first precedence already exists** |
| `contract-everything.ts` | the ONE shared resolution boundary → IQ → emergent cache → emergent RAG |
| `contract-native.ts` | bun:ffi to libcontract (bible-anchor etc. in-process) |
| `contract-shape.ts` / `contract-chain.ts` / `contract-taste.ts` | verdict shape + source-of-truth chain + MIN-over-axes |
| `contract-grant.ts` + `grantGate` | native ed25519 grant/RBAC permission (per-surface opt-in) |
| `egress-chain.ts` | the LEGACY-INTERNET fallback (local→server→proxy HTTP) |
| `x402-fetch.ts` + Faremeter Flex | the payment seam (USDC → owner credit) |

## The dependency spine (native-first, legacy-fallback) — the wave order

1. **internet-ledger seam (FORMALIZE the precedence).** One shared `resolveViaLedger(target)`:
   try the /contract ledger (cached-resolution/IQ) FIRST; on miss, fall to `egressChain` (legacy
   internet). Both paths observable (fallbacks-visible). Most of this is `peekResolution` today —
   the wave NAMES it as THE dependency boundary + inverts precedence to ledger-first-by-default.
2. **execute-through-ledger.** Execution result-cache (`execute-result-cache.ts`, already present)
   becomes a `/contract` exec: producer — run-once, cache-keyed; legacy HTTP fetch is the fallback
   producer. The signed result row IS the cached pointer.
3. **embedding + shape native everywhere.** Every resolve/execute envelope carries the
   `contractVerdictFromEnvelope` shape (done at the CLI emit() boundary) + the bible/embedding
   anchor (contract-native bun:ffi) — so every op is shaped + embedded, not just outputs.
4. **economic close (Faremeter Flex → stFDRY).** x402-fetch settles USDC via Flex →
   `routeRevenue` → Voltr vault → stFDRY NAV (Vine Doctrine). The "internet ledger" is funded by
   real usage; holders earn by abiding. NOT a fee discount (leaks the tithe) — bond-to-maintain
   eligibility. (Mostly `\prop` in the contract paper; the spl_balance eligibility floor is `\impl`.)
5. **legacy-internet as named fallback (its original design).** The HTTP/web stack stays FULLY
   supported — it is the fallback tier, never removed. unbrowse still browses the legacy internet;
   it just RESOLVES through the contract ledger first.

## Gated invariants (each wave = a witness, no fabricated green)
- ledger-first: a cache/IQ hit short-circuits BEFORE any HTTP egress (witness: peek-hit → no fetch).
- legacy-supported: a ledger MISS still resolves via egressChain (witness: cold URL → legacy fetch).
- shaped+embedded: every envelope carries `_contract` + an anchor (witness: emit() boundary).
- funded: x402/Flex settlement credits the owner → vault path (witness: the pay.sh sweep, live).

## Honest scope (named, not faked)
- ~70% of the substrate is already native (the surfaces above). The migration is precedence
  FORMALIZATION + the economic close + naming the legacy tier — NOT a from-scratch rewrite.
- This is MULTI-WAVE (one bounded witnessed wave at a time), not a one-turn completion. Each wave
  lands behind a runnable two-witness gate; the legacy internet is never ripped out (it is the
  original-design fallback the directive explicitly preserves).
- The contract-substrate (aiko/libcontract Zig) work is DONE for the parts unbrowse depends on
  (verdict, grant/RBAC, covenant verbs signed+shipped). unbrowse's job is to DEPEND on it as the
  ledger, which the surfaces above already largely do.

## Wave 1 LANDED (2026-06-22) — API muscle memory (`apiContract`)

"all /contract for every api used becomes /contract muscle memory" — the load-bearing seam:
`src/values/api-contract.ts` `apiContract({ api, args, produce })`. Built on the EXISTING
`cachedResolution` (foundation-first): the contract ledger is consulted FIRST (recall = muscle
memory, no recompute), the LEGACY INTERNET (`produce` — the real HTTP/API call) runs only on a
miss, the result persists as a signed pointer + mirrors to the IQ on-chain ledger + emergent RAG.
Result carries `recalled` (muscle-memory indicator) + the `_contract` verdict shape (shaped all
the way). WITNESSED `tests/api-contract.test.ts` 4/4: an identical call → **the legacy API fired
ONCE** (apiCalls==1); a different-args call → legacy fallback ran. This is "unbrowse dependent on
/contract as the internet ledger, legacy as the fallback" at API granularity — the migration's
load-bearing primitive. NEXT: route real API call-sites (web-search, execute, resolve) through
`apiContract` one at a time, each behind its own no-regression witness.

## Wave 2 LANDED (2026-06-22) — thin frontend proxy (`contractProxy`)

"drill it down — make the whole website just frontend + proxies to the on-chain stuff with kv
emergentdb and graph on top." The frontend-edge twin of apiContract: `frontend/src/lib/contract-proxy.ts`
`contractProxy({ intent, layers:[kv,emergentdb,graph], source })` — resolves an intent through the
LAYERED backing FIRST (recall, no on-chain round-trip), falls to the ON-CHAIN source (the signed
ledger) only on a full miss, back-fills the fastest layer so the next hit is muscle memory. The
website holds no business logic — it proxies + caches; every response carries the _contract verdict.
The real KV/emergentDB/graph bindings are the frontend worker's deploy seam; this defines the
PRECEDENCE. WITNESSED `frontend/src/lib/contract-proxy.test.ts` 4/4: a KV hit → source NOT hit;
precedence kv→emergentdb→graph; full miss → ledger fetched ONCE + back-filled → 2nd call recalled.
NEXT: route real frontend API routes through contractProxy + bind the live KV/emergentDB/graph, one
route at a time behind its own witness; the legacy web stack stays the fallback source.

## Wave 2b COMPLETED (2026-06-22) — a REAL route wired (not a plan)

"complete it properly, don't leave it as a plan." The live prod route `frontend/src/app/[domain]/route.ts`
(unbrowse.ai/<domain> — the website AS a thin wrapper of the per-domain on-chain/backend skill.md) now
RESOLVES THROUGH `contractProxy`: recall the per-domain skill.md through the layered contract backing
FIRST (an in-isolate L0 tier that's REAL on a warm CF worker isolate — bounded 256 + 120s TTL), fetch the
on-chain/backend SOURCE only on a miss. Only a 200 is committed to memory (never an error — no false
witness). Observability: `X-Contract-Recall` + `X-Contract-Layer` headers expose which tier served.
Non-breaking: a miss falls to the exact prior backend fetch (404/502/status/crash-guard all preserved).
The DURABLE cross-isolate KV/emergentDB/graph layers prepend at deploy (the named seam — no live binding
yet). tsc clean; contractProxy primitive 4/4 (incl. the cacheable path). This is the drill-down DONE on a
real route, not a plan.

## LANDED ON MAIN (2026-06-22) — contract-native seams shipped + docs /contract-verified

Merged sync/agent-economy-lineage-clearing → main (fast-forward, 16 commits, 0 conflicts), pushed
origin + gitea. The session's contract-native surface, each pure + witnessed + leak-clean:

- apiContract (f281d43b) — every API read → recall-first muscle memory, legacy HTTP on miss.
- contractProxy (2d0cbe05) + the live /<domain> route (2d360b30) — thin frontend → on-chain, kv/emergentdb/graph seam.
- contractBrowse (9519720f) — kuri go→snap→click loop in /contract shape: READ recalls, ACT re-runs (no false witness).
- payGate (1649b685, e15e2aa2 fail-closed) — opt-in x402 compensation per GET/POST; payment never buys past RBAC.
- payGate ∘ grantGate (da81b9a9) — the RBAC verdict feeds the x402 tier, witnessed end-to-end 10/10 in the backend.
- mirror opt-out (8080e567) — cachedResolution mirror is opt-in so apiContract is safe as a hot read (falsifiable red control);
  fetchLatestVersion is the first real caller (d9af4dc0, mirror:false).

"never devnet" VERIFIED: prod stanzas are all mainnet (X402_NETWORK_MODE=mainnet ×4 + mainnet USDC); the lone devnet
flag is correctly isolated to the gate-staging bench env. Docs /contract-against-code: paper-reflects-code gate 5/5
GREEN, leak-guard clean. Open: wire payGate's per-method price INTO the route's EXISTING x402 gate (reconcile, don't
add a second payment mechanism — Synapse-kind-minimum); bind contractProxy's live KV/emergentDB; the npm CLI + CF prod
release fires through the gated release.yml pipeline (tag → gitea mac-mini), live-verified.
