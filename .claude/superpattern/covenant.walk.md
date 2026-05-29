# COVENANT — WALK ledger (the completion-promise plan)

Graph: `.claude/superpattern/covenant.graph.json` · framework: `claude` · promise: `when`
Started: 2026-05-29 (Ralph loop). Honest tickable ledger for the 7-part completion promise.
No box ticked without evidence (Matt 7:16-20). Build the real thing on real paths (Matt 7:24-27);
fail honestly when you can't.

## The promise, decomposed into 7 truths (ALL must be TRUE to emit `<promise>when</promise>`)

1. **Built** — covenant CDP fully built (10-atom seed → toll/meter/pay primitive in code).
2. **Speced** — whitepaper evaled + benchmarked to spec; every shipped claim has a code anchor.
3. **Pruned** — old guardrails no longer needed are gone.
4. **Awayed** — the "10 commandments" (old rule set) retired, superseded by the 10-atom covenant.
5. **npm** — code emerges to prod via npm (CI release).
6. **OSS** — a GitHub open-source client ships: auditable to match the whitepaper, reveals no moat.
7. **Fair toll** — ZK stays moat+auth; every dimension toll-booth'd in a fair game-theory manner.

## Dijkstra spine (cheapest first-win): now → root → node → verb → walk → seal → emerge
## Off-spine wideners: witness (ZK moat), cache (route-graph moat), konmari (prune + away)

| done | node | atom·verb | truth | tool | status | evidence |
|---|---|---|---|---|---|---|
| [x] | now | start | 0 | — | settled | v7.2.0-preview.0; covenant-seed.ts real (179 lines, 10-atom seed @ 5c1e5bfc7) |
| [x] | root | why·eval | #2 | paper-gate.sh | settled | paper-gate.sh RC=0 — 25 claim anchors bind to code; 0/10 moat terms leaked (iter 1) |
| [ ] | node | what·build | #1,#7 | muonry_edit | open | toll/meter/pay record in covenant-seed.ts + tests |
| [~] | verb | how·build | #7 | muonry_edit | partial | first-discoverer ledger LANDED @ 72ee4d63b (src/covenant-toll-ledger.ts, 6/6 tests, reuser-pays-shortcut proven). Remaining: additive execute call-site (mirror emitExecuteReplayTrace) |
| [ ] | witness | who·eval | #7 | muonry_edit | open | ZK credential↔wallet bind without reveal (moat, closed) |
| [~] | cache | where·build | moat | muonry_edit | partial | route graph + KV cache stay closed |
| [~] | konmari | when·breath | #3,#4 | search+Bash | partial | bench-*.sh deleted; audit + retire remaining stale rules / the "10 commandments" |
| [x] | node | what·build | #1,#7 | muonry_edit | settled | toll/meter/tollNode in src/covenant-seed.ts @ 8a3f1c2d; 11/11 bun tests; no-leak split proven (iter 2) |
| [ ] | seal | why·eval | #2,#6 | Bash | open | leak-guard + paper-gate + seed/toll tests + benchmark-to-spec all RC=0 |
| [ ] | emerge_npm | how·build | #5 | release:preview | **blocked-auth** | irreversible; needs Lewis go |
| [ ] | emerge_oss | where·build | #6 | gh | **blocked-auth** | irreversible + conflicts "public repo frozen by design"; needs Lewis go |
| [ ] | emerge | settle·eval | all | Bash+Agent | open | two witnesses: OSS-client-vs-prod reproduces paper + all gates green |

Legend: [x] settled · [~] in progress · [ ] not started · **blocked-auth** = irreversible
outward action requiring explicit Lewis authorization (core CLAUDE.md: confirm before
irreversible/outward; standing memory: public repo frozen by design, never direct npm publish).

## Standing authorization fork (the ONLY thing the loop cannot settle autonomously)

`emerge_npm` and `emerge_oss` are irreversible outward actions. The loop walks everything up
to `seal` autonomously (reversible local build + gates). It STOPS at the two emerge nodes:
shipping to prod npm and open-sourcing a client to public GitHub both need Lewis's explicit
go, and the OSS release is in direct tension with the standing "public repo frozen by design"
security decision. The promise `when` cannot become genuinely true until (a) build+gates are
green AND (b) Lewis authorizes the two emerge nodes. Until then: do not lie.

## Honest status

**Iter 1 (2026-05-29):** Plan authored (this file + covenant.graph.json). `now` settled
(covenant-seed.ts confirmed: 179 lines, 10-atom seed, real). `root` SETTLED — `paper-gate.sh`
RC=0 (25 shipped-claim anchors bind to code; 0/10 moat terms leaked). One witness for truth #2
(claims anchored) + the no-leak half of truth #6.

Open: node · verb · witness · cache · konmari · walk · seal, then the two blocked-auth emerge
nodes. The promise `when` is FALSE (truths #1,#5,#6,#7 unmet; #2,#3,#4 partial). Not emitting it.

**Iter 3 (2026-05-29, Ralph session):** Re-verified the autonomous green with real runs —
`paper-gate.sh` RC=0 (25 anchors, 0/10 moat terms leaked), `leak-guard.sh` RC=0,
`bun test tests/covenant-seed.test.ts` = **11/11 pass** (43 expect calls). Truth #1 (Built)
confirmed genuinely real — not just a ledger claim. Konmari audit: 15 bench-*.sh deleted
(~3751 lines) but ~70 scripts remain in `scripts/` → #3/#4 still **partial**, and aggressive
prune is RECKLESS now (214-file uncommitted working tree; standing peer-collision risk in this
exact tree). No literal "10 commandments" file exists — the phrase = retire stale guardrails
superseded by the 10-atom covenant.

**Terminal blocker surfaced to Lewis (iter 3):** the `emerge` goal depends on `emerge_npm`
(irreversible prod npm publish) AND `emerge_oss` (irreversible public OSS release, in DIRECT
TENSION with the standing "public repo frozen by design" security decision). No amount of
autonomous looping makes the promise true — both need explicit Lewis authorization, and #6
would reverse a documented security stance I must not unilaterally undo. Surfaced the fork.

**Iter 4 (2026-05-29, jesus-loop in-thread, Opus):** Re-grounded on real runs (paper-gate
RC=0, leak-guard RC=0, covenant-seed 11/11) — ledger claims verified, not trusted. Settled the
load-bearing half of `verb`: `src/covenant-toll-ledger.ts` @ 72ee4d63b — the first-discoverer
ledger. Route→discoverer binding is immutable (first writer wins forever, so a later agent
cannot steal the shortcut reward); reusers pay the shortcut and the ORIGINAL discoverer is
paid; the 402 event is sealed through the wallet root (payout bound into the signature,
non-repudiable). 6/6 tests on real Ed25519, no mocks. Committed clean through pre-commit gates
(no --no-verify). `verb` now **partial** — remaining half is the additive, never-throws
execute call-site (mirror `emitExecuteReplayTrace`), a separate scoped step.

Loop contract this run: walk every reversible node (verb call-site → witness → konmari → walk
OSS client → bench Exa+BrowseComp → seal) autonomously; STOP at the two emerge nodes for
explicit Lewis go (unchanged from iter 3 — the fork stands). The user's new args RESOLVE the
OSS design half: a SEPARATE thin auditable client matching the whitepaper WHAT, no moat leak,
ZK stays moat+auth — not an unfreeze of the frozen public repo. The actual outward publish
(npm + public push) still needs Lewis's trigger.
