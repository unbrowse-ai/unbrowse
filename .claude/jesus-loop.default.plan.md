# Plan — beat Exa + BrowseComp, ship auditable, toll-booth everything (jesus-loop default)

Branch `jl/exa-browsecomp` (in-place). Co-runs with the `.codex` exa-browsecomp
orchestrator + its background benchmark agents — same branch, one body of work.
Walk `.claude/superpattern/exa.graph.json`; settle each node Plan→Build→Test→Judge.

## GOAL (north star)
Two-witness, reproducible, agent-judged: **unbrowse beats Exa's published numbers on
every targeted reproducible Exa benchmark AND reproduces BrowseComp accuracy > 0.336**,
with the whitepaper evaled + benchmark-backed, obsolete guardrails gone, the
10-commandments seal honored (no fake-green), the code shipped to prod via npm AND an
**auditable open-source GitHub client that matches the whitepaper without revealing the
moat** (capture/RE/economic engine + zk kept as moat & auth), and **every value flow
toll-boothed via a fair game-theoretic x402 split**.

## ACCEPTANCE CRITERIA (each ticks only on a REAL, agent-judged number — two witnesses)
1. **Beat Exa (reproducible suites).** unbrowse > Exa published on every targeted
   reproducible suite: WebCode RAG groundedness > 79.4; Highlights > 94.8/93.2;
   plus the Tier-2 public suites where applicable (SimpleQA > 0.874, FRAMES > 0.881).
   Run against the cloned real harness (`exa-labs/benchmarks`, `perplexityai/search_evals`),
   not a toy corpus. Contents (82.8) is explicitly NON-reproducible — not chased.
2. **BrowseComp > 0.336**, reproduced on the real `perplexityai/search_evals`
   suite=browsecomp with the OpenAI grader, full published set (not the 2-row seed).
3. **Whitepaper evaled + benchmark-backed.** `paper-gate.sh` + `leak-guard.sh` exit 0
   (reflects code, no moat leak) AND every `[shipped]` performance claim cites a real
   benchmark number from criteria 1–2.
4. **Obsolete guardrails gone + 10-commandments _awayed_ (baked-in, not scaffolding).**
   Dead bench scripts/guardrails removed; the 10-commandments are no longer a standalone
   guardrail layer — they are *retired into mechanical gates* (precommit seal: leak-guard +
   contract-leak + paper-gate) so the law runs as code, invisible, not as living scaffolding.
   No fake-green markers (xfail painted green, status-code-as-verdict) survive a mutation check.
5. **Auditable OSS client.** The public `@unbrowse/client` surface maps claim-by-claim
   to the whitepaper, is independently auditable, and leaks zero moat (capture/RE/economic
   engine, covenant mechanism internals). zk stays as moat & auth.
6. **Toll-booth everything (fair game theory).** Every value flow priced through a fair
   x402 split (operator cut + first-discoverer reward + site absorbs rounding, sums
   exactly, no leak), wired in code with passing tests.

## NON-GOALS
- Chasing marketing-only Exa numbers with no public harness (Fast/Instant latency,
  exa-code, Websets 320x, Deep/Deep-Max) — counter-position only, never claim a win.
- Chasing WebCode Contents 82.8 (golden markdown licensing-excluded → non-comparable).
- Shipping search() SERP wins before search() is a real ranker (fabricated green).

## RISKS
- **⛔ LOAD-BEARING EXTERNAL BLOCKER — funded grader key (WAVE-05).** Criteria 1 & 2 cannot
  emit a real number without a FUNDED OpenAI grader. The only key on this machine returns
  `429 insufficient_quota` on every completion model; no funded key found across all six
  credential sources. The harness is fully stood up — the exact run command is recorded in
  `bench/exa/WAVE-05.md`. This is a **funding/decision dependency, not a code gap**: no number
  may be fabricated and no grader swapped (a different grader ≠ Exa's published methodology =
  fake-green). Mitigation: build every node NOT gated on the grader (search productization,
  snippet enrichment, OSS client, guardrail cleanup, whitepaper, toll-booth); fire criteria
  1 & 2 the moment a funded key lands in `~/.config/env/global.env`, or `/steer` if the
  methodology changes.
- **search() ranker — SOLVED at adapter level (WAVE-05).** The real query→ranked-URLs SERP
  ranker landed (`bench/browsecomp/unbrowse_browsecomp_searcher.py`, DDG-impersonate fetch,
  LIVE-verified). Remaining: productize it into unbrowse itself + snippet enrichment for
  multi-hop BrowseComp. No longer the blocker.
- **Peer-loop collision on the shared tree.** A codex `exa-browsecomp` loop runs on this same
  branch/working tree (`.codex/jesus-loop.exa-browsecomp.local.md`) — already caused a
  HEAD-race + Stop-hook hijack once. Mitigation: one canonical branch, trust git not sidecars,
  judge orphaned fruit instead of reverting, never destroy the peer's ledger.
- **Moat leak** in the OSS client / whitepaper. Mitigation: leak-guard + paper-gate gate every commit.
- **Fake-green**: ticking a box on a TOY corpus or a status code. Mitigation: agent judges
  the raw real number; no box without it.

## OUT-OF-SCOPE
- Irreversible release actions (npm publish, github push of the OSS client, prod deploy)
  are CONFIRM-GATED — the loop builds & verifies to the edge, the human fires the release.

## HONEST CURRENT STATE (refreshed at WAVE-05, 2026-05-29)
- Gate 1 (beat Exa suites): **BLOCKED on funded grader** (external). Harness stood up.
- Gate 2 (BrowseComp > 0.336): **BLOCKED on funded grader** (external). Harness + real
  search() SERP ranker stood up + LIVE-verified.
- Gate 3 (whitepaper): paper-gate PASS (25 anchors, 0 leaks) + leak-guard clean — STRUCTURAL
  green; benchmark-backing pending criteria 1–2.
- Gate 4 (guardrails + 10-commandments awayed): 21 obsolete `bench-*.sh` removed (konmari);
  precommit seal passing. Remaining: verify the law fully runs as mechanical gates.
- Gate 5 (auditable OSS client): not started.
- Gate 6 (toll-booth): **SETTLED, two witnesses** — x402-gate+flex+pricing+e2e 51/51 +
  covenant-toll-emit 3/3.
- Bench history: WAVE-01..05 in `bench/exa/`. WAVE-05 = search ranker landed, gates 1&2
  recorded as funding-blocked (no fabricated number).
