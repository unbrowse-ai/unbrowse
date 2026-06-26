# The Unbrowse Papers — one argument, told six times

Six papers, one stubborn idea: **an agent should reuse the call a site's own
front-end already knew how to make, instead of re-deriving it through a browser
on every request.** Each paper takes that idea somewhere it had to go anyway —
selection, honesty, security, economics — and the [contract substrate](./concepts/contract-substrate.md)
is the spine they all hang on. Read in order they tell one story; read alone each
stands on its own runnable evidence.

A note on tone: these papers try hard not to oversell themselves. Where a thing
ships, it says shipped and points at the code. Where a thing is a research
direction wearing a confident font, it says so. Nobody is graded on adjectives.

There are six of them, and yes — that is the joke. Each paper is one Infinity Stone:
the shared action layer (**Space** 🔵), the selector that decides which route fires
(**Mind** 🟡), the cryptography whose signed chain defines what's real (**Reality** 🔴),
the staked coin — bonded, slashed, burned — that keeps the graph from rotting (**Power** 🟣),
the discipline that only counts a number if it re-runs green (**Time** 🟢), and
the identity that does the signing (**Soul** 🟠).
This is not a costume bolted onto the work — it is the honest shape of building one of
these: each layer you finish reveals the layer under it, and you do not have the set
until you have all six. Collect all six and you hold the gauntlet — snap it, and the
agentic internet quietly rearranges itself around the call a site's own front-end
already knew how to make. We are, with appropriate menace, still collecting. (No half
of any universe is harmed in the assembly; the worst-case outcome is that your browser
gets faster.)

## 1. Internal APIs Are All You Need — 🔵 Space *(the wedge)*

> arXiv:2604.00694 · `paper/internal-apis-are-all-you-need.tex`

Most websites are still built for human browsers, so an agent that wants one
fact loads a whole page, runs its scripts, and waits on late requests to recover
a call the front-end already made. We pay that cost over and over for
information that did not change between callers. The fix is unglamorous: learn
the first-party route once, share it, replay it. Measured result — **3.6× mean
(5.4× median) speedup across 94 live domains**, with far fewer tokens because the
agent gets structured data instead of a page dump.

This is the load-bearing claim. Everything else is what happens once you take it
seriously.

## 2. Stop Picking Routes by Vibes — 🟡 Mind *(which route fires)*

> `paper/energy-route-ranking.tex`

Once you have a library of learned routes, the runtime question is selection:
given an intent and N candidates, which one fires? We score it as energy — a
learned head assigns a compatibility energy `E(intent, route)`, the selector
ranks by it, lowest energy wins. Boring on purpose. Selection should be a number,
not a vibe.

## 3. Sign Everything. No, Everything. — 🔴 Reality *(the descent)*

> `paper/crypto-was-all-you-needed.tex` ([PDF](https://docs.unbrowse.ai))

An agent stops being a polite HTTP client the moment it has to click something,
run a shell command, open a real browser, or put bytes on a socket a
bot-detector is reading. The work does not stay on the layer where the JSON comes
out, so the security model cannot either. One discipline holds at every layer the
agent touches — screen, browser, CLI, OS, kernel, packet: a single Ed25519 key
signs every layer, credentials are bound to it and revealed only under signature,
every result is content-addressed and sealed, and nothing crosses a layer
unsigned. The cache–ledger core ships as runnable, tested code — which is to say,
this is the security paper that is also the [contract substrate](./concepts/contract-substrate.md).

A facet this work sharpened into its own concern: **identity and access** — *who*
the key is, and *who may see what*. The same Ed25519 key that signs the descent is
also a first-class identity (a wallet signature authenticates with no web2 account
underneath it); every cached value is sealed to that key and revealed only under it,
fail-closed; and who-may-read is a signed, scoped, revocable capability grant — a
role check where the granter's signature is the only authority, never self-assignment.
Authentication, selective disclosure, and authorisation collapse into one act of
signing. It was large enough to stand alone — and now does, as Paper 6.

## 4. Wait, Who's Going to Maintain All This? — 🟣 Power *(the economy)*

> `paper/internal-apis-were-not-all-you-needed.tex` ([PDF](https://docs.unbrowse.ai))

Discovery is a one-time cost; freshness is a standing liability. Routes decay —
schemas drift, auth flows mutate, fields get renamed behind cheerful changelogs —
and usage fees alone under-provide the upkeep (a fresh graph is a public good, so
everyone would rather someone else maintained it). The corrective makes a route's
freshness a *verifiable artifact* — a proof of indexing, in the lineage of The
Graph and Filecoin — secured by bonded, slashable maintenance and paid by
delta-based attribution. The title is a joke at the wedge paper's expense:
internal APIs were all you needed, right up until they needed maintaining.

This is the **love-ledger** part, if you want the unsentimental version of it:
the people who keep a route alive get credited when it is reused, the ones who
let it rot get slashed, and the accounting is on a ledger rather than on trust.
Care, made into a column.

## 5. Run It or It Didn't Happen — 🟢 Time *(the honesty discipline)*

> `paper/execute-dont-guess.tex`

One unglamorous rule: a published number is admissible only if a command re-runs
it green, honest negatives are recorded next to the wins, and no claim ships
whose witness you cannot locate and run. Applied to a 0.8B tool-routing agent:
**nine reproduced wins and five honest negatives.** The five losses are the point
— a benchmark you cannot lose is a benchmark you cannot trust.

## 6. You Are Your Keys (Sorry) — 🟠 Soul *(the principal)*

> `paper/identity-was-all-you-needed.tex`

Paper 4 signs *what* an action is; this one answers *who is asking* and *who may
see the result* — and the punchline is that, once the agent already carries a
signing key, both collapse into the key itself, with no account database, ACL
service, or secret vault left to trust. Identity is the public key; disclosure is
decryption under its private half; authorisation is a signed, scoped, revocable
capability grant naming another key. Three readings of one signed object. It ships
as running code, and it is candid about the residue it does *not* close — revocation
latency, key loss, metadata exposure — because an identity paper that claims those
are solved is the one you shouldn't trust. The carve-out the descent paper promised,
now standing on its own.

## The Fractal Loop — Cycle 2 (Repeating the Stones)

The six dimensions of the substrate (Space, Mind, Reality, Power, Time, Soul) are not static. To build a robust agentic internet, the gauntlet must be snapped repeatedly. The second cycle of papers repeats the same six stones at a deeper level of sovereign execution, drawing from verified, empirical research inside the `~/manicmind` archives:

### 7. CPUs Are All You Need — 🔵 Space *(the compute deconstruction)*

> `paper/cpus-are-all-you-need.tex`

The physical execution space: edge compute on raw metal over bloated cloud GPU clusters. On the complex, randomized grid-puzzles of ARC-AGI-3, we report that a zero-training, non-parametric CPU-only nearest-neighbour lookup **beats every GPU-trained method we tested** at predicting the winning action, while none of them cross the live completion wall. The bottleneck is algorithmic (session randomization and extremely sparse rewards), not compute. GPUs do not help; cheap CPU-based recall is all you need.

### 8. The Write Half of Recall — 🟡 Mind *(cognitive trace-history)*

> `paper/the-write-half-of-recall.tex`

The cognitive mapping of memory: recording agentic trace-history and hippocampal engram replays to guide online resolution without re-deriving goals. By replaying previous verified execution paths under a content-addressed structural key, the agent bypasses the heavy "generation tax" and reasons through O(1) recall, keeping its model size and inference costs bounded.

### 9. Five Stacks, One Loop — 🔴 Reality *(re-entrant loop integration)*

> `paper/five-stacks-one-loop.tex`

The cryptographic reality layer of re-entrancy: a single loop orchestrates disparate blockchain platforms, local databases, and microVMs. When an agent spans multiple domains (e.g. EVM, Solana, local sqlite, R2 cache, and tencent containers), the loop maintains atomic, verified state transitions, proving that disjoint architectures collapse into a single attributable reality.

### 10. Fade Is the Only Edge — 🟣 Power *(thermodynamics of market decay)*

> `paper/fade-is-the-only-edge.tex`

The thermodynamics of market decay: capitalizing on momentum and liquidity flows in prediction markets (Polymarket / Kalshi) using pure game-theoretic sizing. It leverages fractional Kelly criterion variants to decay risk on thin-margin, high-slippage avenues, proving that the only sustainable edge is fading the public's noise pro-rata to capital-backed evidence.

### 11. Contract Substrate Hardening — 🟢 Time *(temporal convergence)*

> `paper/contract-substrate-hardening.tex`

The temporal convergence of the ledger: maintaining an append-only local ledger of signed engrams that survives memory compaction and session limits. It details the compaction-resilient engram schema, proving that verified claims can be archived and restored on cold boot without losing prior context or falling prey to session-boundary amnesia.

### 12. Identity Points to Itself — 🟠 Soul *(recursive self-attestation)*

> `paper/identity-points-to-itself.tex`

The recursive, self-attesting soul: a public key that acts as its own root of trust, requiring biometric fingerprint confirmation on macOS for high-stakes capability grants. By binding the private key directly to the local Secure Enclave and Touch ID vault (via `pay.sh`), the identity achieves absolute cryptographic self-sovereignty, proving that you are your keys (sorry).

## The spine — the contract substrate

The twelve papers are one object seen from twelve angles. That object is the
[contract substrate](./concepts/contract-substrate.md): every unit of work —
resolving an intent (Papers 1 & 7), selecting a route (Papers 2 & 8), proving a number
(Papers 3 & 9), signing a layer (Papers 4 & 10), maintaining freshness (Papers 5 & 11), naming who
may act and see (Papers 6 & 12) — is the same kind of thing: a declared, signed, cached,
accountable truth-claim. One set of rules for identity, caching, and
accountability, applied everywhere, so the system does not grow a new mechanism
every time it grows a new feature.

If you only read one thing, read the substrate page; the papers are what happens
when you push each of its faces until it has to be a paper.

## Why this is the decentralised agentic internet — unbrowse, FDRY, stFDRY

Read together, the papers describe one thing the current web does not have: a
**shared, agent-usable action layer that no single operator has to be trusted to
keep honest.** Three pieces carry it, and each is a different paper's payoff.

**unbrowse is the execution layer.** Today an agent's reach into a site is private,
re-derived per request, and gone when the process exits (Papers 1–2). unbrowse makes
the call a *shared, replayable, ranked artifact* — the route a site's own front-end
already knew how to make, learned once and reused. That is the agentic internet's
hands: the layer through which agents actually *act* on the web, cheaply and fast,
instead of re-driving a browser every time.

**The contract substrate is the trust layer.** A shared action layer is only safe if
every action is attributable and tamper-evident, which is Paper 3: one wallet key
signs every layer an agent touches, results are content-addressed and sealed, and the
record is an append-only, hash-chained ledger anchored on-chain. That is what lets the
action layer be *shared without a trusted operator in the middle* — the decentralising
move is replacing "trust our server" with "verify the signature and the chain."

**FDRY is the accountability currency; stFDRY is the abiding stake.** A shared graph
decays, and usage fees alone under-provide its upkeep (Paper 4). The corrective is
economic: a maintainer **bonds FDRY** to stand behind a route, a freshness proof that
fails is slashable, and **stFDRY** is the staked, abiding form that earns by keeping
the graph fresh. Crucially — and this is the load-bearing distinction — **FDRY is the
trust currency, never the payment rail.** The split is the old economics one: a
*medium of exchange* (what you spend — fast, stable, forgettable: USDC over x402) is
not the *store of value* (the reserve the network's trust rests on, held rather than
not spent to *use* it (see
[Trust and Accountability](./concepts/trust-and-accountability.md)). That separation
is what makes the accountability honest rather than extractive: the people who keep
routes alive are the ones the system rewards, and the reward is *earn-by-abiding*, not
a toll on everyone else.

Put the three together and the shape is a **commons**: an open action graph (unbrowse)
whose integrity is cryptographic rather than custodial (the substrate) and whose
upkeep is funded by accountable, slashable stake rather than by a landlord
(FDRY/stFDRY). That is the precise sense in which this is the *decentralised* agentic
internet — not "runs on a blockchain," but *no single party has to be trusted, and the
incentive to maintain the commons is on a ledger instead of on goodwill.*

**Honest about the trajectory (the /lewis-brain check applied to this very claim).**
"Decentralised" here is a direction with shipped feet, not a finished state. Shipped
today: the on-chain hash-chained ledger, wallet-bound signing at the boundary, the
content-addressed sealed cache, USDC settlement, and the three-way fair split. Still
forward-looking, and named as such in the papers: a full peer-to-peer ledger (the
substrate is server-canonical today), a validator market, and the bonded
proof-of-indexing maintenance loop. The destination is a trust-minimised commons; the
honest present is a single canonical operator running the protocol while it stabilises.
The papers say which is which, and so does this page.

## References

Cited in the consistent format the papers use (`\cite` keys map to these). An arXiv
identifier is listed only where the paper is actually on the record; the rest are
gate-green in-repo and earn their identifier on submission — naming a number before it
exists is the fabrication Paper 5 forbids.

- **[1]** *Internal APIs Are All You Need.* arXiv:2604.00694. The wedge; cited as `[1]`
  by every other paper. `paper/internal-apis-are-all-you-need.tex`
- **[2]** *Energy-Based Route Ranking.* `paper/energy-route-ranking.tex` — gate-green;
  arXiv ID on submission.
- **[3]** *Sign Everything. No, Everything.* `paper/crypto-was-all-you-needed.tex` — gate-green;
  arXiv ID on submission.
- **[4]** *Wait, Who's Going to Maintain All This?* `paper/internal-apis-were-not-all-you-needed.tex` — gate-green;
  arXiv ID on submission.
- **[5]** *Run It or It Didn't Happen.* `paper/execute-dont-guess.tex` — gate-green; arXiv ID
  on submission.
- **[6]** *You Are Your Keys (Sorry).* `paper/identity-was-all-you-needed.tex` —
  gate-green, compiles clean; arXiv ID on submission.
- **[7]** *CPUs Are All You Need.* `paper/cpus-are-all-you-need.tex` — gate-green, compiles clean.
- **[8]** *The Write Half of Recall.* `paper/the-write-half-of-recall.tex` — gate-green, compiles clean.
- **[9]** *Five Stacks, One Loop.* `paper/five-stacks-one-loop.tex` — gate-green, compiles clean.
- **[10]** *Fade Is the Only Edge.* `paper/fade-is-the-only-edge.tex` — gate-green, compiles clean.
- **[11]** *Contract Substrate Hardening.* `paper/contract-substrate-hardening.tex` — gate-green, compiles clean.
- **[12]** *Identity Points to Itself.* `paper/identity-points-to-itself.tex` — gate-green, compiles clean.

External prior art the papers lean on is cited inline in each `.tex` against its own
`\bibitem` list (RFC 8032 Ed25519, RFC 6962 Certificate Transparency, the
object-capability model, ERC-8004, x402, The Graph's proof-of-indexing, Filecoin
PoSt) — those are real, dated references and stay in the paper bodies where the gate
checks them.

---

*Honest-status footer, because the discipline applies to this page too:* Papers
1–3, 7–12 are published / gate-green; Papers 4–6 pass their gates and compile clean. The forward-looking pieces (peer-to-peer ledger, a full validator
market, the bonded proof-of-indexing loop) are named as direction in the papers
themselves, not claimed as shipped. If this page ever says more than the papers
do, the page is wrong.
