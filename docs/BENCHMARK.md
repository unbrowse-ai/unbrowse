# unbrowse benchmark (release gate)

The unbrowse release gate is an open agent-judged benchmark sourced from
real user complaints on Reddit. This document is the canonical
description: where the corpus comes from, how a probe is shaped, how the
gate runs, and how to propose new rows.

## Goal of the benchmark

Test whether an agent can use the unbrowse MCP surface to actually
complete a real intent on a real site, not whether the harness can
produce a green status code. The verdict is an agent reading the
artifact bundle (resolve shortlist, pick, execute response, page
snapshot) against `harness/probes/GATE_JUDGE.md`. The harness only
collects evidence.

## Source: 76 Reddit threads, 12 subreddits

The locked corpus was distilled from two evidence-build waves:

- Wave 1: 8 query pairs, 38 records
- Wave 2: 8 query pairs (sharper queries), 38 records

Subreddits queried:

```
r/LocalLLaMA  r/AI_Agents  r/mcp  r/LangChain  r/AskProgramming
r/webdev  r/scraping  r/selfhosted  r/n8n  r/Anthropic
r/ChatGPT  r/singularity
```

Wave 2 falsified the wave-1 ranking. With the sharper queries, the
x402_monetization hypothesis jumped from last to second-strongest. The
two-wave pattern is now the methodology: always falsify wave 1.

Every claim on the unbrowse landing page traces to a thread id at
`frontend/docs/POSITIONING.md`. New probes follow the same trace shape:
the row in the corpus carries a comment with the source thread id when
the source is a Reddit complaint.

## Corpus shape

`harness/probes/corpus-gate.txt`. One probe per row:

```
intent|context_url|lane|probe_id
```

- `intent`: the actual ask, in the language a user or agent would type.
  No regex, no JSON envelope. The ranker reads this as text.
- `context_url`: the page the agent is on when the intent fires. This
  is the URL the resolve pipeline uses for A8 entity substitution and
  context-path matching. It is not a "page to scrape"; it is the
  context the agent is operating in.
- `lane`: declared. See lane taxonomy below.
- `probe_id`: a zero-padded sequence. Maps to a row in
  `bench-gate-baseline.json`.

Lanes:

| Lane | Pass shape |
|---|---|
| `public` | Real data for the intent. An empty array is a fail; an interstitial is a fail. |
| `anchor` | Real data OR a structured `resolve_hard_handoff` envelope with a usable `next_step`. |
| `hostile` | Real data OR a `vendor_blocked` marker that names the vendor. Generic anti-bot is a recognized failure mode, not a substrate bug. |
| `auth-gated` | Real data OR `auth_required` plus an actionable `auth_hint`. Login is the user's job; surfacing the handoff is the substrate's job. |

## Locked vs running

- 58 probes in the locked corpus (`harness/probes/corpus-gate.txt`).
- 66 in the running superset (additional probes the auto-corpus-feeder
  has proposed; the agent reviews diffs in
  `.bench-gate/proposed-probes-<ts>.diff` and cherry-picks via PR).

A row lands in the locked corpus only after a human-reviewed PR. There
is no auto-merge from the feeder.

## Judge: agent reads the artifact bundle

`harness/probes/GATE_JUDGE.md` is the rubric. Per probe, the judge
agent reads:

- `resolve.shortlist.json`: the candidates the ranker returned.
- `resolve.pick.json`: the agent's deterministic top pick (and why).
- `execute.input.json`: the full execute payload, including the
  context URL the substituted endpoint resolves to.
- `execute.response.raw`: the response body unwrapped.
- `execute.meta.json`: the trace, decision steps, vendor signals,
  drift flags, fallback path.
- `capture.meta.json`: HAR + interceptor capture summary, the
  `iso_self_check` host comparison, browser-block signals.
- `index.store.json`: what landed in the marketplace from this run.

The judge calls each probe one of:

```
RETRIEVE_PASS           the agent got real data matching the intent
RETRIEVE_PASS_HANDOFF   structured envelope with actionable next_step
                        (anchor/auth lanes only)
RETRIEVE_EXCLUDED_BLOCKED   vendor-blocked; excluded from denominator
RETRIEVE_FAIL_WRONG_SHAPE   data returned but wrong shape for intent
RETRIEVE_FAIL_ERROR_BODY    response was an interstitial / error page
RETRIEVE_FAIL_DRIFT_ENVELOPE   schema drift, body preserved but
                               unhandled by agent
```

Coverage is `PASS / (PASS + FAIL)`; browser-blocked and auth-gated rows
that returned a proper handoff are excluded from the denominator (they
are not substrate failures).

## How to run the gate locally

```bash
git clone https://github.com/unbrowse-ai/unbrowse
cd unbrowse
bun install
node packages/skill/scripts/assert-kuri-vendor.mjs
bun scripts/mcp-gate-parallel-collect.ts
```

Optional knobs:

- `UNBROWSE_GATE_CONCURRENCY=4` — bounded worker pool size. 4-6 is
  validated. Higher is unverified; the per-probe `iso_self_check`
  surfaces crosstalk if it happens.
- `UNBROWSE_GATE_PROBE_TIMEOUT_MS=90000` — per-probe deadline. On
  timeout the collector writes a `crashed_during_collect` marker and
  resume-skip handles the next run.
- `UNBROWSE_GATE_STOP_ON_FAIL=1` — early-stop primitive. First
  structural fail writes `.stop-marker` (probe id, lane, intent, url,
  reason, raw signals) and exits 2.
- `UNBROWSE_GATE_SKIP_EMPTY_SNAPSHOT=1` — skip browser-infra failure
  classes (empty_snapshot, go_failed). These are orthogonal to
  substrate fixes; track them separately.
- `UNBROWSE_FORCE_HEADLESS=1` — pinned by the collector before
  spawning the in-process app. Belt-and-suspenders against env-leak
  from peer harnesses popping visible Chrome.

Artifacts land in `.bench-gate/run-<ts>/<probe_id>/`. The judge reads
the bundle in-thread (`claude -p` against `GATE_JUDGE.md` + the
artifact paths).

## How to propose a new probe

1. Find a real failure. Either a Reddit thread describing the failure
   in the user's voice, or a row from the auto-corpus-feeder diff
   (`.bench-gate/proposed-probes-<ts>.diff`), or your own session.
2. Add one line to `harness/probes/corpus-gate.txt`:

   ```
   intent|context_url|lane|<next probe_id>
   ```

3. Pick the lane honestly. If the site uses Cloudflare aggressively,
   it is hostile. If login is required, it is auth-gated. If real data
   is reachable in a clean session, it is public.
4. Run the gate locally and confirm the verdict matches the lane's
   pass shape.
5. Open a PR. The PR template asks for:
   - the intent, in the user's voice
   - the context URL
   - the lane and the reason (one sentence)
   - the source thread id if any (`t3_...`)
   - the verdict the gate produced locally

6. Reviewers run the gate against the proposed row before merging. A
   probe that does not pass on someone else's machine is a probe that
   has a hidden dependency on yours; it does not land.

## Auto-corpus-feeder (the loop side)

`harness/probes/auto-corpus-feeder.py` reads
`GET /v1/telemetry/recent-failures` (admin-gated) and proposes new
rows grouped by `(normalized_intent, host)`. It does NOT auto-merge.
It writes a diff under `.bench-gate/proposed-probes-<ts>.{txt,diff}`
that an agent reviews in-thread, then cherry-picks and PRs the rows
the agent judges worth keeping.

This closes the loop: real wild failures are observable in the
telemetry, surfaced as proposed probes, and the corpus grows from
genuine pain. The merge stays human, the proposal stays automatic.

## What the gate does NOT test

- Latency or token usage (the arXiv paper covers those across 94 live
  domains: 3.6x mean, 5.4x median over Playwright; not the release
  gate's job).
- Browser-block edge cases for sites the team has not chosen to
  bypass. The `vendor_blocked` marker is a recognized non-bug.
- Auth flows that require human login. The substrate's job is to
  surface an actionable `auth_required` handoff; the user logs in.
- Per-domain shortcuts. By design. If a fix requires `if host == X`,
  it is the wrong fix; write the structural detector instead.

## Substrate principle (load-bearing)

Borrowed from the project root CLAUDE.md. The gate enforces it:

> The substrate enables; it does not prescribe. The harness collects
> evidence; the agent judges. Heuristic verdicts in the harness are
> the failure mode this gate exists to prevent.

If a future contributor wires `if status == 200 then PASS` into the
collector, the PR does not land. The collector emits raw evidence;
verdicts live in `GATE_JUDGE.md` plus the in-thread agent reading the
bundle.

## Citation

If you cite this benchmark in a paper, presentation, or blog post:

> unbrowse release gate, v7.0.0. 58-probe agent-judged corpus sourced
> from 76 Reddit threads across 12 subreddits.
> https://github.com/unbrowse-ai/unbrowse/blob/main/harness/probes/corpus-gate.txt

Include the commit SHA you ran against; the corpus grows.
