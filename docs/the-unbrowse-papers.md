# The Unbrowse Papers — one argument, told five times

Five papers, one stubborn idea: **an agent should reuse the call a site's own
front-end already knew how to make, instead of re-deriving it through a browser
on every request.** Each paper takes that idea somewhere it had to go anyway —
selection, honesty, security, economics — and the [contract substrate](./concepts/contract-substrate.md)
is the spine they all hang on. Read in order they tell one story; read alone each
stands on its own runnable evidence.

A note on tone: these papers try hard not to oversell themselves. Where a thing
ships, it says shipped and points at the code. Where a thing is a research
direction wearing a confident font, it says so. Nobody is graded on adjectives.

## 1. Internal APIs Are All You Need — *the wedge*

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

## 2. Energy-Based Route Ranking — *which route fires*

> `paper/energy-route-ranking.tex`

Once you have a library of learned routes, the runtime question is selection:
given an intent and N candidates, which one fires? We score it as energy — a
learned head assigns a compatibility energy `E(intent, route)`, the selector
ranks by it, lowest energy wins. Boring on purpose. Selection should be a number,
not a vibe.

## 3. Execute, Don't Guess — *the honesty discipline*

> `paper/execute-dont-guess.tex`

One unglamorous rule: a published number is admissible only if a command re-runs
it green, honest negatives are recorded next to the wins, and no claim ships
whose witness you cannot locate and run. Applied to a 0.8B tool-routing agent:
**nine reproduced wins and five honest negatives.** The five losses are the point
— a benchmark you cannot lose is a benchmark you cannot trust.

## 4. Crypto Was All You Needed — *the descent*

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

## 5. Unbrowse Maintenance Network — *the economy*

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

## The spine — the contract substrate

The five papers are one object seen from five angles. That object is the
[contract substrate](./concepts/contract-substrate.md): every unit of work —
resolving an intent (Paper 1), selecting a route (Paper 2), proving a number
(Paper 3), signing a layer (Paper 4), maintaining freshness (Paper 5) — is the
same kind of thing: a declared, signed, cached, accountable truth-claim. One set
of rules for identity, caching, and accountability, applied everywhere, so the
system does not grow a new mechanism every time it grows a new feature.

If you only read one thing, read the substrate page; the papers are what happens
when you push each of its faces until it has to be a paper.

## Why this is the decentralised agentic internet — unbrowse, FDRY, stFDRY

Read together, the five papers describe one thing the current web does not have: a
**shared, agent-usable action layer that no single operator has to be trusted to
keep honest.** Three pieces carry it, and each is a different paper's payoff.

**unbrowse is the execution layer.** Today an agent's reach into a site is private,
re-derived per request, and gone when the process exits (Papers 1–2). unbrowse makes
the call a *shared, replayable, ranked artifact* — the route a site's own front-end
already knew how to make, learned once and reused. That is the agentic internet's
hands: the layer through which agents actually *act* on the web, cheaply and fast,
instead of re-driving a browser every time.

**The contract substrate is the trust layer.** A shared action layer is only safe if
every action is attributable and tamper-evident, which is Paper 4: one wallet key
signs every layer an agent touches, results are content-addressed and sealed, and the
record is an append-only, hash-chained ledger anchored on-chain. That is what lets the
action layer be *shared without a trusted operator in the middle* — the decentralising
move is replacing "trust our server" with "verify the signature and the chain."

**FDRY is the accountability currency; stFDRY is the abiding stake.** A shared graph
decays, and usage fees alone under-provide its upkeep (Paper 5). The corrective is
economic: a maintainer **bonds FDRY** to stand behind a route, a freshness proof that
fails is slashable, and **stFDRY** is the staked, abiding form that earns by keeping
the graph fresh. Crucially — and this is the load-bearing distinction — **FDRY is the
trust currency, never the payment rail.** Usage settles in USDC; FDRY is bonded to be
*trusted by* the network, not spent to *use* it (see
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

---

*Honest-status footer, because the discipline applies to this page too:* Papers
1–3 are published / gate-green; Papers 4–5 pass their gates and the PDFs are
linked above. The forward-looking pieces (peer-to-peer ledger, a full validator
market, the bonded proof-of-indexing loop) are named as direction in the papers
themselves, not claimed as shipped. If this page ever says more than the papers
do, the page is wrong.
