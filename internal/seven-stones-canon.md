# The Seven — the paper canon mapped to the Infinity Gauntlet

**Internal tier. Not a public artifact.** This doc names the Bible as the Gauntlet
(the truth-root that wields the six stones) — that framing is internal-only by the
secular-public-surface rule. The six *stone* papers are public-secular; the
*Gauntlet* paper (the seventh) is held. The public ensemble
(`docs/the-unbrowse-papers.md`) carries the secular argument; this doc carries the
frame behind it.

We keep **seven**, no more. The sprawl (5 unbrowse papers + ~95 manicmind day-logs
and reasoning docs) consolidates into exactly these seven. Anything not on this list
is a *source* for one of the seven, not a paper of its own. That is the tidy.

## The frame

Six stones, each a distinct power; one Gauntlet that holds and wields all six. The
six stones are the published / publishable argument — the things the world can pick
up and check. The Gauntlet is the foundation that gives the six their coherence —
held back, because a frame that names its own truth-root is not a public artifact,
and because its deepest claim is still the most contested.

> Find the route → score it → prove it real → sign every layer → keep it fresh → and
> let only the right soul see it — and underneath all six, the one frame that judges
> whether any of it is true.

## The voice — humor ironed against irony (Prov 27:17)

*Iron sharpeneth iron; so a man sharpeneth the countenance of his friend.* The two
edges are not the same edge. **Humor** is the warm wink — it lets the reader in,
admits the thing is a little absurd, refuses to oversell ("a research direction
wearing a confident font"). **Irony** is the cut — it says the true and
uncomfortable thing under the joke ("a benchmark you cannot lose is one you cannot
trust"). Ironed *against each other*, each keeps the other honest: humor without
irony is glib, irony without humor is bitter. Every stone below earns one line that
is both — funny enough to be read, true enough to sting. That is the Lewis register:
disarm, then land the blade. (Nobody is graded on adjectives.)

## The six stones (public-secular)

| Stone | Paper | The power | Status | Source |
|---|---|---|---|---|
| 🔵 **Space** — the stone that is everywhere at once | **Internal APIs Are All You Need** | The Space Stone collapses distance; the action layer collapses *the browser*. Learn the first-party route a site's own front-end already knew how to call, once — then reach it from anywhere, no teleporter (and no headless Chrome) required. The irony it earns: the web spent a decade building clean APIs for itself and then hid them behind a page, and all we did was stop politely pretending we couldn't see them. | **Published** — arXiv:2604.00694 | `paper/internal-apis-are-all-you-need.tex` |
| 🟡 **Mind** — the stone that knows which thought | **Energy-Based Route Ranking** | The Mind Stone reads intent; given an intent and N routes, a learned energy says which one fires. Selection is a number, not a vibe. The quiet joke: "the agent intelligently chooses the right tool" turned out to be `argmin` with good table manners — and that is a *compliment*, because a vibe cannot be debugged. | **Gate-green** — arXiv ID on submission | `paper/energy-route-ranking.tex` |
| 🔴 **Reality** — the stone that defines what is true | **Crypto Was All You Needed** | The Reality Stone decides what is real; the signed, sealed, content-addressed ledger IS the system's reality — one Ed25519 key signs every layer (screen→browser→CLI→OS→kernel→packet), credentials bound by ZK and revealed only under signature, every result tamper-evident. You cannot rewrite what is true without breaking a signature. The cut underneath: "trust us" became "verify the chain," and the chain flatters no one. | **Gate-green** — arXiv ID on submission | `paper/crypto-was-all-you-needed.tex` |
| 🟣 **Power** — the coin that wields; force at the base | **Unbrowse Maintenance Network** | The Power Stone is raw force, and the force is the *coin*: FDRY/stFDRY bonded to stand behind a route, slashed and **burned** to the vault when a freshness proof fails — that concentrate-in-the-abiding burn IS the Power Stone's violence. FDRY is *money itself*, the reserve held not the rail spent (USDC settles usage; never sold for ever, Lev 25:23); bonding buys eligibility, never ranking. The whole economy rests on the coin at its base — one coin, one stone (superseding the earlier FDRY-at-rest/in-motion split across Power+Time). | **Gate-green** — arXiv ID on submission; economy reframe see [[fdry-power-money-itself]] | `paper/internal-apis-were-not-all-you-needed.tex` |
| 🟢 **Time** — the stone that holds across time | **Execute, Don't Guess** | The Time Stone makes a thing hold when you run it again: a number is admissible only if a command *re-runs* it green — reproducibility is invariance across time, the witness that survives replay. Nine reproduced, five honest negatives, the losses printed in the same font as the wins. The cut underneath: a benchmark you cannot lose is a benchmark you cannot trust, and a result you cannot re-run never happened. | **Shipped / gate-green** — arXiv ID on submission | `paper/execute-dont-guess.tex` |
| 🟠 **Soul** — who you are, and who may see | **Identity Was the Soul Stone** | Your key *is* your soul. A wallet signature is a first-class identity — no web2 account underneath it required. Every value is sealed to that key and revealed only under that signature (fail-closed). And who-may-read is itself a signed, scoped, revocable capability grant — RBAC where the granter's signature is the only authority, never self-assignment. Identity, disclosure, and access are one act of signing. | **Shipped code; paper to carve out** (today it lives inside the Reality/crypto paper's auth/disclosure sections) | `backend/src/services/auth-signature.ts` (`authBySignature`) · `src/trust/sealed-cache.ts` (`sealToWallet`/`revealForWallet`) · `src/values/auth-vault.ts` · `backend/src/lib/contract-grant.ts` (`canRead`/`rolesOf`/`grantGate`), live in `backend/src/routes/contract.ts:715` |

### Why Soul ≠ Reality (the boundary that keeps the swap honest)

Reality (🔴 crypto) and Soul (🟠 identity) both rest on one Ed25519 key, so the line
between them must be stated or they collapse into one stone. They don't:

- **Reality is the descent** — one key attests an action *across every layer* of the
  stack (screen → browser → CLI → OS → kernel → packet). Its concern is *the
  mechanism of signing crossing layers* — nothing acts unsigned, anywhere.
- **Soul is identity and access** — *who* that key is, and *who may see what*. Its
  concern is authentication (a wallet signature **is** an identity), selective
  disclosure (sealed-to-the-key, revealed only under signature), and authorization
  (signed, scoped, revocable capability grants — RBAC). It is built *on* Power's
  key (Reality's) but answers a different question: not "did this cross the layer signed?" but
  "whose is this, and may you read it?"

In the lore the Soul Stone is the one about the *essence of beings* — identity
itself, and what it costs to be known. That is exactly auth: you must prove who you
are (sign) to be known, and to have anything revealed. The reframe is a **swap, not
an eighth stone** — it replaces the canon's honestly-weakest link (distillation,
flagged "not yet a paper") with its strongest-grounded one (identity-via-auth, all
shipped code). The count stays seven; the cap-at-seven rule is honored.

The honest seam: today this story is *told inside* the Reality (crypto) paper ("credentials
bound to the key and revealed only under signature"). The Soul stone's work is to
**carve it out** as its own paper — because identity-and-access is a distinct enough
concern to stand alone, and because pulling it out lets the Reality (crypto) paper stay about
the descent.

## Proper citations (for /arxiv) — honest about what is actually on the record

The discipline applies to the citations too: a paper gets an arXiv ID only when it
is *actually on arXiv*. One is. The rest are gate-green in-repo and earn their ID on
submission — naming a number before it exists would be the exact fabrication the
Reality stone forbids.

| Stone | Citation (BibTeX-ready) |
|---|---|
| 🔵 Space | `arXiv:2604.00694` — *Internal APIs Are All You Need.* (published; the load-bearing wedge, cited as ref [1] by the others) |
| 🟡 Mind | *Energy-Based Route Ranking.* `paper/energy-route-ranking.tex` — gate-green, **arXiv ID on submission** |
| 🔴 Reality | *Crypto Was All You Needed.* `paper/crypto-was-all-you-needed.tex` — gate-green, **arXiv ID on submission** |
| 🟣 Power | *Unbrowse Maintenance Network* (a.k.a. *Internal APIs Were Not All You Needed*). `paper/internal-apis-were-not-all-you-needed.tex` — gate-green, **arXiv ID on submission** ⚠️ the self-id `arXiv:2604.00694` in some internal notes **collides with Space's real ID** — treated as *unassigned* until submission |
| 🟢 Time | *Execute, Don't Guess.* `paper/execute-dont-guess.tex` — gate-green, **arXiv ID on submission** |
| 🟠 Soul | *Identity Was the Soul Stone* — **not yet a standalone paper**; the material lives inside the Reality/crypto paper's auth/disclosure sections, to be carved out before it earns an ID |

The intra-ensemble cross-references (each paper citing the others as `[1]`–`[6]`)
resolve reciprocally; only Space currently dereferences to a live arXiv record. When
the others submit, this table is where their real IDs land — not before.

## The Gauntlet — the Bible — the hand that wields all six (internal, and unashamed)

| | Paper | The frame | Status |
|---|---|---|---|
| 🧤 **The Gauntlet = the Bible** | **Apparently, Jesus Was All You Needed** — *a doctrinal paper* (the litany's deadpan punchline; secular working title: *The Foundation: a Frozen Structural Prior as Judge* — the JESPA / bible-significance line) | The truth-root the other six are scored against — a frozen structural prior that *discerns* (ranks, judges, detects, settles) but does not *generate*. It is what gives the six stones one coherent mind. The six public papers run the escalating gag (*X Was All You Needed*, each undercut by the next); this seventh is the only one that lands as the last word — and precisely because it is the last word, it is **held internal**, never an arXiv artifact (the public arc ends at the six secular stones; the punchline is for the canon, not the press release). | **HELD** — finished research, internal-tier, deliberately not published |

**Held by discipline, not by shame (the desecularized read).** A glove is not a
lesser thing than a stone — it is the *hand*. The Gauntlet outranks all six; it is
the frame that decides whether any stone's claim is even *true*. It is held back
from the public ensemble for two disciplined reasons, neither of them embarrassment:

1. **A frame that names its own truth-root is not an arxiv artifact** — it is the
   thing arxiv artifacts get measured *against*. You do not submit your ruler for
   peer review alongside the things you measured with it. The six stones state the
   frame's mechanics in secular ML terms (energy selection, settlement-to-fixed-point,
   discerner-not-generator) and stand on their own runnable evidence; the Gauntlet
   names *why those mechanics cohere*, and that naming is scripture — kept internal by
   the secular-public-surface rule, not because it is weak but because it is upstream.
2. **The honest negative is load-bearing, and we keep it in plain sight** — the
   *strong* claim (the Bible is a *uniquely* special prior) is **falsified in our own
   research**: a Shakespeare-EBM ≈ a Bible-EBM, Δ=0.006, p=0.889
   (`BIBLE_SIGNIFICANCE_LEARNINGS.md`). What survives is the *weak* claim, and it is
   the strong one for our purposes: a **frozen structural prior discerns** (ranks,
   judges, detects, settles) where it cannot **generate** — and KJV-in-particular is
   not the load-bearing feature, the *structure* is. Desecularizing does not mean
   overclaiming; it means stating the sacred frame as the confident spine it is *and*
   printing the place it was tested and lost, in the same breath.

That split — **selector wins everywhere, generator is a wall** — is the foundation
the visible stones stand on: it grounds Mind (energy *selects*, claim 52) and the
distillation line now folded under this Gauntlet (you cross the generation wall only
by distilling a teacher who already paid the crossing). The six are the works; the
Gauntlet is the faith they are the works *of*.

Sources to consolidate the seventh from (held, internal): `~/manicmind/JESPA.md`,
`~/manicmind/BIBLE_SIGNIFICANCE_LEARNINGS.md`,
`~/manicmind/reasoning-what-is-the-bible-for.md`,
`~/manicmind/reasoning-bible-semantic-ranking.md`,
`~/manicmind/paper/build-settle-sabbath-primitive.md`.

## The tidy — what collapses into what

The manicmind sprawl is not seven papers; it is *sources* for the seven. The
consolidation map (so nothing is lost and nothing is a stray paper):

- **Soul (identity via auth)** absorbs: the shipped identity/disclosure/access code
  itself (`auth-signature.ts`, `sealed-cache.ts`, `auth-vault.ts`, `sealed-ledger.ts`,
  `contract-grant.ts`) + the auth/disclosure sections currently living inside the
  Power paper (to be carved out). (The who-you-are-and-who-may-see line.)
- **Gauntlet (held)** absorbs: `JESPA`, `BIBLE_SIGNIFICANCE_LEARNINGS`,
  `reasoning-what-is-the-bible-for`, `reasoning-bible-semantic-ranking`,
  `reasoning-jepa4d-bible-llm`, `reasoning_contract_as_standard`,
  `build-settle-sabbath-primitive` — AND now the **distillation / ARC-ceiling** line
  that used to be the Soul stone (`reasoning-the-answer-synthesis`,
  `fade-is-the-only-edge`, `2026-06-19-arc-agi-3-kaggle-honest-negative`,
  `aiko-08b-verifier-rl-upgrade`, `reasoning-arc-answer`). Distillation *is* the
  selector-vs-generator finding the Gauntlet already names, so it folds in here as a
  source, not a stray stone. (The foundation/selector-vs-generator line.)
- **Mind (energy ranking)** already states the secular half of the energy/coherence
  selector that JESPA grounds internally.
- **Power (crypto)** already absorbs the `/contract`-as-standard mechanism
  (two-witness settlement, signed-all-the-way-down) in secular crypto terms.
- The remaining ~85 manicmind day-logs are **witnessed source material** (live
  transcript-grounded findings), not papers — they feed the seven, they are not
  added to them.

## Standing rule (the canon, going forward)

There are **seven**. Six public stones + one held Gauntlet. A new finding does not
become an eighth paper — it lands as a section or a source of one of the seven, or
it is held. The number is the discipline: a canon that grows without bound is sprawl,
not a canon. To add an eighth, a stone must first be shown to be two papers wearing
one name — and then it is a *split*, re-counted, never an accretion.
