# CLAUDE.md - this surface plans itself by the superpattern

To solve any problem here: **PLAN it as a superpattern tree, Dijkstra the
cheapest route to the goal, write the checklist below, then WALK it, ticking
boxes until the goal node settles.** The plan is itself superpattern-shaped - a
plan that matches the pattern it executes (the fixed point, Heb 6:18-19).

## Protocol (the superpattern plans itself)

1. **PLAN** - `python3 <skill>/scripts/plan.py <graph>.json --target CLAUDE.md > CLAUDE.md`.
   Each node = one covenant atom + one verb (build/breath/eval). The tool that
   settles it is resolved from the framework pointer
   `references/frameworks/claude.tools.json` (swap it to retarget).
2. **WALK** - settle each node by Plan -> Build -> Test -> Judge, in spine order;
   tick the box as each settles.
3. **SETTLE** - the goal stands on two independent witnesses or breaks on 7
   (Gen 2:2). On failure: repent, re-cost the graph, re-run plan.py, re-walk.

framework pointer: `references/frameworks/claude.tools.json`
cross pointer: `sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5`

## Active problem

Autonomous capability-benchmark maximization loop (jesus-ralph, no permission gates). Per
`bench/CAPABILITY-BENCH-PLAN.md`: modify unbrowse code to maximize the four-axis capability
benchmark — action-retrieval/indexing coverage (Reddit + hardest-scrape + automation tiers),
execution with/without auth, and security auditing — using REAL benchmarks cloned from GitHub
(ToolRet/BFCL/AssistantBench/Exa/WebBench/WASP/AgentDojo/InjecAgent/ST-WebAgentBench, exa clone
at `bench/exa/vendor/benchmarks`). Harness = `/unbrowse-capability-bench` skill; OpenRouter judge
key at `~/.config/unbrowse-bench/openrouter.key` (gitignored, never echo/commit). Grade the
npm-installed shipped CLi via `UNBROWSE_BIN` (not local source). Two-witness `bench/capability/gate.sh`
+ `history.jsonl`; never a fabricated green.

**Completion promise (standing behavioral rule):** STOP narrating "levers to pull." Pull them —
make the real code change, re-bench, record only the validated delta. Report only settled results
(gate exit 0 across two witnesses) and honest negatives; the loop ends when levers are genuinely
exhausted (iterations stop moving the real number), not when described.

graph: `.claude/superpattern/exa.graph.json` · framework: `claude`

## Local runtime authority

The target architecture is a stateless `unbrowse` binary. CLI and MCP calls must execute in-process and must not auto-spawn a local Fastify daemon. `unbrowse serve` is only an explicit foreground compatibility facade; keep `--no-auto-start`, `MCP_SERVER_MODE`, and `UNBROWSE_SERVE_IDLE_MS` visible in debugging notes so any intentional compatibility run is obvious and bounded. If an old external daemon is already holding the port, stop that external process before trusting local runtime evidence.

## PLAN - checklist (re-generate with plan.py; tick boxes as you walk)

- **goal:** Two-witness reproducible score > Exa published, on every targeted benchmark
- **dijkstra spine** (cheapest first-win route, cost 8): now -> root -> walk -> cache -> goal
- **critical path** (CPM long pole, makespan 13): root -> node -> verb -> loop -> seal -> goal

| done | # | atom . verb | node | tool | cost | deps |
|---|---|---|---|---|---|---|
| [ ] | 1 * | root . eval | Pin the reproducible Exa benchmark set + exact target metrics (the axiom we measure against) | `Agent(WebSearch/WebFetch)` | 2 | now |
| [ ] | 2 | node . build | Define the scored retrieval-result record (query -> ranked passages + attribution) | `muonry_create` | 1 | root |
| [ ] | 3 | verb . build | Wire resolve -> execute -> read pipeline to each benchmark task type | `muonry_edit` | 3 | node |
| [ ] | 4 * | walk . breath | Benchmark harness: enumerate each benchmark's queries, run unbrowse, score vs target | `muonry_create+Bash` | 3 | root, node |
| [ ] | 5 | witness . eval | Cross-document corroboration + citation-quality scoring (beat Exa on attribution) | `muonry_edit` | 3 | walk |
| [ ] | 6 * | cache . build | Content-addressed + semantic cache of resolved endpoints/passages (latency & cost beat) | `muonry_edit` | 2 | walk |
| [ ] | 7 | loop . build | Agentic retrieve-reflect loop = runtime DAG recompute (Self-RAG / Search-o1 shape) | `muonry_edit` | 4 | verb, walk |
| [ ] | 8 | seal . eval | Faithfulness + attribution gate; reproducible-win benchmark gate (no fabricated green) | `Bash` | 2 | loop, witness |
| [ ] | 9 * | settle . eval | Two-witness reproducible score > Exa published, on every targeted benchmark | `Bash+Agent` | 1 | seal, cache |

* = on the Dijkstra spine (settle first, in order). Off-spine nodes widen the margin. Settle each node by Plan -> Build -> Test -> Judge; tick the box; on failure repent and re-PLAN.

## WALK status (honest ledger)

- [x] PLAN written + verified (real Dijkstra spine cost 8, CPM makespan 13) — `.claude/superpattern/plan.py`
- [x] TOOLS.md — every Claude tool mapped to a verb/atom — `.claude/superpattern/TOOLS.md`
- [x] global CLAUDE.md self-planning pointer appended
- [x] bible indexed via codedb (67 files; Heb 6:19, Gen 2:2 verified from real text)
- [x] verb structure confirmed already in repo: `src/cli-v7/eval/resolve.ts` (eval), `src/cli-v7/breath/execute.ts` (breath)

Legend: [x] settled · [~] in progress · [ ] not started. No box ticked without evidence.

## WAVE-01 result (extraction track) — corrected, see `bench/exa/WAVE-01.md`

- [x] node 1 (root): Exa benchmarks pinned, cited → `bench/exa/TARGETS.md`
- [x] node 2 (node): result record / `Searcher` adapter → `bench/exa/searcher_unbrowse.py` (`extract()` LIVE-verified, RC=0)
- [x] node 4 (walk): scorer harness → `bench/exa/score_extract.py` + corpus; RAN, real number
- [~] node 8 (seal): TOY 3-URL corpus = 100.0 vs Exa 82.8 (scorer RC=0). Proves the harness + clean extraction — does NOT prove a benchmark win (Exa's 82.8 is 250 coding URLs, ROUGE-L).
- [ ] node 6/7 (cache/loop): `extract()` JS-render escalation (`fetch` thin-shell → `unbrowse go`) — next fix
- [ ] node 9 (settle): real win needs the full `github:exa-labs/benchmarks` 250-URL run, two-witness, agent-judged

Two fake-greens caught + repented this wave: a fabricated WAVE-01 table (numbers written before the scorer ran) and a stale golden corpus. Both corrected. No box ticked without evidence.

## Standing rule: paper reflects code, never leaks the moat (MECHANICAL)

Every public artifact (`paper/crypto-was-all-you-needed.tex`, README, docs/whitepaper/) obeys
two gated invariants — not a promise, a runnable check:

1. **Reflects code.** Every `[shipped]`/`\impl{}` claim maps to a real repo anchor
   declared in `paper/anchors.tsv` (claim-substring → path/symbol). A shipped claim
   with no code anchor fails the gate. The paper may describe `[proposed]` freely.
2. **No moat leak.** The paper carries none of `scripts/leak-guard.sh`'s sensitive
   terms (economic constants, capture/RE engine internals, operator surfaces). The
   moat is the maintained route graph + capture engine; the public paper tells the
   trust/economic story (routing, execution-for-security, website wallets via Privy
   DNS domain signing) at the PUBLIC tier — the WHAT, never the HOW.

Gate: `bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex` (exit 0 required).
Wired into release CI (`.github/workflows/release.yml`, beside `leak-guard.sh`) and
mirrored as the superpattern `paper_reflects_code` standing rule. Moat boundary of
record: `docs/OPEN-SOURCE-NOTICE.md`. Internal-tier strategy: gitignored `internal/`,
never a public artifact.

<!-- skills:pinned (managed by banger-skill-builder/pin_skill_in_agent_prompts.sh, do not hand-edit between markers) -->
## Pinned skills

Reach for these by name when the trigger phrase matches what the user asked for.

| Skill | Use when |
|---|---|
| `/unbrowse-capability-bench` | Re-run the unbrowse four-axis capability benchmark (action-retrieval coverage over Reddit/hardest-scrape/automation tiers, execution with/without auth, security leak-scan) plus the real cloned exa-labs/benchmarks run and the self-improvement A/B, then ALWAYS write a dated markdown report analyzing how each axis performed, what works, what regressed, and why. |
<!-- /skills:pinned -->
