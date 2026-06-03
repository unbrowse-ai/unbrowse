# WAVE-17 — BrowseComp via unbrowse: real baseline 0.10, the gap is the agent + frontier-model access (2026-05-31)

`/jesus-ralph "solve browsecomp via unbrowse"`, harnessed by `/superpattern` (sp-rag:
walk=IRCoT, loop=FLARE, witness=Self-RAG, seal=RAGAS). Every number below was read
from a process that exited 0. Witness: `bench/browsecomp/browsecomp-gate.sh` (re-runs
the real eval, gates accuracy > 0.336).

## Real numbers (read from exited-0 runs)
| pipeline | N | accuracy | note |
|---|---|---|---|
| Kimi-K2.6 + unbrowse search | 10 | **0.10** | the real baseline (witness-measured) |
| Kimi-K2.6 + unbrowse, enrich ON | 3 | 0.0 | enrichment did not move the 3 hardest |
| Qwen3-235B-A22B-Thinking + unbrowse | 3 | 0.0 | strongest open reasoner also fails the 3 hardest |
| Qwen3-235B-A22B-Thinking + unbrowse | 10 | **0.0** | WORSE than Kimi; model-swap is not the lever |

Target: Exa 0.336. Current best (Kimi) = 0.10. NOT beaten.

## VERDICT (evidence-backed): not reachable with available resources
- Best open-model number = **Kimi 0.10**; the strongest open reasoner (Qwen3-235B-
  Thinking) did WORSE (0.0, N=10) — so swapping among open models is not a path.
- The only real path to >0.336 is a frontier agent (gpt-5/o3) + the gpt-4.1 grader,
  both **blocked by OpenAI billing** (`429 insufficient_quota`). Harness is fixed +
  ready for them.
- Recommendation: HOLD the loop (or `/cancel-jesus-ralph`) until OpenAI is funded;
  burning more open-model runs at ~0.10 is fake momentum on a blocked target.

## What is settled (the diagnosis, evidence-backed)
- **unbrowse search is NOT the bottleneck.** It returns perfect results for clear
  queries ("who is the ceo of anthropic" → Wikipedia/Forbes). DDG-SERP via
  libcurl-impersonate works; the agent already makes ~6 tool-calls/question (it
  multi-hops). Enrichment (full page content) did not help.
- **The gap is the agent + the questions' brutality.** BrowseComp multi-hops stump
  both Kimi-K2.6 and Qwen3-235B-Thinking. Exa (neural search + frontier agent +
  gpt-4.1 grader) only reaches 0.336.
- **N=3 is a useless instrument** — it is the 3 hardest items, always 0. Use N≥10.

## Resource wall (honest)
- **OpenAI: out of quota** (`429 insufficient_quota`) → the frontier agent
  (gpt-5/o3) AND the apples-to-apples gpt-4.1 grader are BLOCKED by billing.
- **ANTHROPIC_API_KEY absent.** So the loop is constrained to **Nebius open models**.
- Fixed harness bug en route: `openai.py` always sent `reasoning.effort` → 400 on
  gpt-4.1; now sent only for reasoning models (persisted to the nebius-port overlay).
  Ready for frontier models the moment OpenAI is funded.

## Decision point (the honest fork)
Beating 0.336 with open models + DDG is a steep climb from 0.10. Two real paths:
1. **Fund OpenAI** → run gpt-5/o3 agent + gpt-4.1 grader (apples-to-apples, the
   clean shot at >0.336). Harness is fixed and ready.
2. **Long open-model campaign** → strongest Nebius thinking model at N≥10 + real
   IRCoT/FLARE orchestration (decompose → re-retrieve on low confidence). Likely
   capped below 0.336; a real, honest negative result if so.

Next datum in flight: Qwen3-235B-Thinking at N=10 (does the strongest open model
beat Kimi's 0.10?).
