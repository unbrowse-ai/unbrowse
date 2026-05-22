# Server-side `/contract` pattern on the unbrowse DAG

Status: DESIGN — draft 1, 2026-05-23. Contract: `6912f735` (child of organ `4a98fbee`).

## North star

Every edge of the resolve → execute DAG is a **contract** in the
`~/.claude/skills/contract` sense: a declared truth claim with a mechanical
check, an iterate loop, and an append-only ledger row. The DAG stops being a
schema-plus-runtime and becomes a **living organism** in which every
promotion is a KEY 2 agent judgement against real evidence, and every
failed wave is a learn-from-execution row in the ledger.

This document does not propose a new engine. It maps the eight contract
shapes onto surfaces unbrowse already has.

## The DAG today (descriptive)

A captured endpoint flows through:

```
extractEndpoints
  → extractAuthHeaders → storeCredential
  → mergeEndpoints
  → generateLocalDescription
  → augmentEndpointsWithAgent      (LLM-augmented; PII risk surface)
  → buildSkillOperationGraph       (typed nodes + requires/yields edges)
  → cachePublishedSkill            (server-authoritative sanitize gate)
  → queueBackgroundIndex           (EmergentDB vector + KV)
```

At resolve: route cache → marketplace → first-pass browser (8s) → browse
handoff → live capture. At execute: walk the typed graph; every binding
parameterised; credentials thread through `OperationBinding`. Edge
confidence today lives in `reliability_score` (Bayesian, post-`unbrowse_reflect`)
consumed by `rankEndpoints`. Nothing else carries a falsifiable truth
claim back into a ledger.

## The pattern

Every edge becomes a contract with one of three pointer shapes:

| Edge kind | Contract shape | `--action` |
|---|---|---|
| Schema-shaped (extract/sanitize/merge) — mechanical gate | **cell** | shell or pure check |
| Promotion-shaped (publish, route-select, rank, reliability) — needs agent judgement | **judgment** | `agent-judges` |
| Composition (SkillOperationGraph, a phase gating on all sub-edges) | **funnel** | `funnel` |
| Re-fire per capture (extract→sanitize→publish runs many times) | **loop** | `loop-until:<body>` |
| Sub-edge depends on another edge's truth | **contract-ref** | `contract:<id>` |

The pipeline becomes:

```
extract     → cell        — no extracted endpoint carries a residual secret
augment     → judgment    — no augmented description leaks PII
sanitize    → cell        — publish-sanitize.ts gate exits 0
publish     → judgment    — the published skill is findable + actionable
rank        → judgment    — the top-ranked endpoint actually answers the intent
execute     → loop        — every execute re-iterates; reliability is wave history
reflect     → cell        — unbrowse_reflect posts a contract _mark event
```

## Why this changes anything

1. **The marketplace becomes a contract graph.** Every published skill is
   an organ; every endpoint is a child cell. Stale = a failed `iterated`
   row from the last execute. `unbrowse_reflect` writes `_mark`.
   Reliability falls out of the ledger; not a separate scalar.

2. **Freshness is iterate.** `OperationBinding.freshness_token` becomes
   the wave counter on a loop contract. Stale = body action exits
   non-zero on the next iterate.

3. **The bench gate is a child organ.** Every release-gate probe in
   `harness/probes/corpus.txt` is a contract; the gate is a funnel.
   `bench-local.sh` already collects; the contract iterate writes the
   ledger row. KEY 2 stays with the agent in-thread (`contract 469ce311`).

4. **Pointer-not-payload preserved** (`contract 3c2dd353`). The client
   never holds the contract logic — only an opaque `contract:<id>`.
   Iterating happens server-side; the client reads the current truth.

5. **Agent KEY 2 is never bypassed.** No script in the pipeline bakes a
   PROMOTE/PASS/FAIL verdict (`contract 5b9574ee`, C-G01). The contract
   substrate's two-key exit is the same discipline, recursively applied.

## First migration target (proof)

The **publish edge** — `cachePublishedSkill` → `queueBackgroundIndex` —
is the cleanest first conversion:

1. On every publish, the worker declares
   `contract declare "<skill-id> published artifact is non-leaking,
   findable in global search, and executable" --action agent-judges`.
2. The agent (the `unbrowse_review` MCP tool) iterates the contract
   once on first execute; KEY 1 = execute result, KEY 2 = in-thread
   judgement.
3. `unbrowse_reflect` becomes a thin wrapper over `contract _mark` —
   `success` marks satisfied, `failure` appends an `iterated` row with
   `agent_verdict: regressed` and surfaces the wavefront (every
   endpoint referencing this skill).
4. Reliability = `count(iterated where agent_verdict=genuine) /
   count(iterated)` over a trailing window. `rankEndpoints` keeps its
   `reliability * 40` weight but reads from a ledger view, not a KV
   scalar.

If this proof lands, the same template applies to extract, augment, and
rank in turn.

## Open questions (HOLD)

1. **Where does the ledger live server-side?** (a) EmergentDB qdkv with
   key `contract:ledger:<id>`, (b) Cloudflare D1 (single table,
   append-only, indexed by id + ts), (c) Postgres via Neon.
   Recommendation: **D1**, with KV read-through cache on the hot path.
2. **Client never writes directly** (pointer-not-payload). MCP layer
   posts to `POST /v1/contract/iterate` that signs the row with the
   agent's API key and writes server-side. Same for `_mark`.
3. **`unbrowse_reflect` API unchanged** — server-side handler translates
   its outcome into `_mark`. Backwards compatible.
4. **Bench-gate harness change is minimal** — each probe gets a
   deterministic contract id (hash of intent+URL). One `iterated` row
   per probe per run.

## Non-goals

- Auto-rendering verdicts from the ledger. KEY 2 stays in thread
  (C-G01). The ledger is evidence, not truth.
- Rewriting `rankEndpoints` in this design. That migration follows the
  publish-edge proof.
- A new database — either D1 or existing EmergentDB/Postgres; no third
  store.

## Next action (spawn under 6912f735)

> Publish-edge proof: `POST /v1/contract/iterate` route + D1 ledger
> table; `unbrowse_reflect` server handler writes `_mark`;
> `rankEndpoints` reads reliability from the ledger view (replacing the
> KV scalar) for one hand-picked skill; bench-local probe demonstrates
> reliability changes when an execute marks the contract `regressed`.

The smallest end-to-end slice that proves the pattern without rewriting
the pipeline.

## CLI as a /contract --action target (child `7ae6a26d`)

A `/contract --action` is a pointer to a capability. The unbrowse CLI
is invokable as that pointer directly — under `--json`, every command
emits ONLY its JSON payload to stdout (progress chatter is rerouted to
stderr), and the exit code is KEY 1.

Worked example — declare a per-domain freshness contract whose check
is an unbrowse resolve probe:

```bash
bash ~/.claude/skills/contract/scripts/contract declare \
  "github.com/trending resolves with trace.success" \
  --action "bun src/cli.ts resolve --json --intent 'github trending repositories' --url https://github.com/trending | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"trace\",{}).get(\"success\") else 1)'"
bash ~/.claude/skills/contract/scripts/contract iterate <id>
```

KEY 1 is the exit code of the resolve+parse chain; KEY 2 stays
in-thread (the agent reads the JSON payload via stderr or re-runs and
judges). The CLI is side-effect-free under resolve; iterating the
contract appends one `iterated` ledger row to `.claude/contracts.jsonl`
per wave. Any unbrowse capability — resolve, execute, health, search,
account, billing-status — is usable as a mechanical check without an
intervening shell wrapper.

Pre-fix: `--json` printed `[perf]`, `[lifecycle]`,
`[direct-document]`, `[unbrowse]` progress lines on stdout BEFORE the
JSON payload, so `json.load(sys.stdin)` raised `JSONDecodeError` and
KEY 1 was un-readable for a /contract `--action`. Fixed in
`src/cli.ts:main()` — when `--json` is set, `console.log/info/warn` are
redirected to `process.stderr.write`. `process.stdout.write` (used by
`output()`) is untouched, so the JSON payload stays on stdout.

## Provenance

- Contract organ: `4a98fbee`
- This child: `6912f735`
- CLI-as-harness child: `7ae6a26d`
- Inherits: `5b9574ee` (C-G01), `3c2dd353` (pointer-not-payload),
  `469ce311` (no deterministic verdict heuristics), `9c162224` (ledger
  is the rule substrate).
