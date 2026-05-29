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
4. **Obsolete guardrails gone + 10-commandments seal.** Dead bench scripts/guardrails
   removed; the precommit seal (leak-guard + contract-leak + paper-gate) passes; no
   fake-green markers (xfail painted green, status-code-as-verdict) survive a mutation check.
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
- **search() is not a real SERP ranker** (the load-bearing blocker): resolve returns API
  endpoints, not ranked content URLs from a cold query. Every search benchmark gated on
  building the browse-layer query→ranked-URLs engine (node-7 agentic loop). Mitigation:
  dedicated build task #3.
- **Branch/HEAD races + Stop-hook hijacks** from concurrent default-named loops (already
  bit us once; peer parked). Mitigation: one canonical branch, trust git not sidecars.
- **Paid grader cost** per wave. Mitigation: small `--limit` slices until a path proves out.
- **Moat leak** in the OSS client / whitepaper. Mitigation: leak-guard + paper-gate gate every commit.
- **Fake-green**: ticking a box on a TOY corpus or a status code. Mitigation: agent judges
  the raw real number; no box without it.

## OUT-OF-SCOPE
- Irreversible release actions (npm publish, github push of the OSS client, prod deploy)
  are CONFIRM-GATED — the loop builds & verifies to the edge, the human fires the release.

## HONEST CURRENT STATE (start of loop)
- Gate 3: paper-gate PASS (25 anchors, 0 leaks) + leak-guard clean — STRUCTURAL green;
  benchmark-backing pending criteria 1–2.
- Gate 4: 21 obsolete `bench-*.sh` removed (konmari); precommit seal passing.
- Gate 6: **SETTLED, two witnesses** — x402-gate+flex+pricing+e2e 51/51 + covenant-toll-emit 3/3.
- Gates 1, 2: background agents standing up the real harnesses for first real numbers.
- Gate 5: not started.
- Bench history: WAVE-01..04 in `bench/exa/`; WAVE-05 will record the first real numbers.
