# The task gate's bank (UNB-208)

Staging is promoted to public only with 90% line coverage in every gated part and no task lost (AGENTS.md, "Tests,
requirements and the merge scorecard"). This folder is the task half: a fixed bank of real tasks, run through a
scratch node's MCP with a real model as the client and as the judge.

| File | What it is |
|---|---|
| `bank.json` | The full bank: seven Steve found wrong or empty on staging on 24 Nov 2026 (UNB-300; each marked `known`, expected to fail, until it is right: then the gate refuses until the mark is off), three searches on the staging criteria's own sites (lazada.sg, carousell.sg, ticketmaster.com; the judge reads each answer for five results with name, price or date, and link), 75 from the unbrowse6 coverage bank (unbrowse6 8b7ff88, not deferred, a deterministic check, passed at least once, no wall expected) and one per site of the Lundy nightly set (13). The pick rule is in `pick_rule`; Lewis approves the bank. |
| `prompt.md`, `judge.md` | What the client is asked (the unbrowse6 harness prompt) and what the judge is asked. `judge-warm.md` is added for a warm twin asked a new value (judged against its cold answer), `judge-warm-read.md` for a warm twin asking the same read again. |
| `../popular-sites/top-1000.json` as `--bank` | The bench (UNB-307): the top 1,000 Tranco sites (UNB-260's list, not rebuilt), made into 2,000 tasks by one rule for every site (`run_gate.py bench_tasks`; `run_gate.py tasks --bank ../popular-sites/top-1000.json` counts them). A search case (346; its url takes `{q}`): the cold task asks its goal with its first value, the warm twin with its second, judged against the cold answer, browserless or it fails. A read case (654): the cold task reads the front page's main content, the warm twin asks the same read again, answered by the route the cold ask learned, no browser. Each task keeps its case's `tranco_rank` and `url_source`; each check (at least three results, or front-page items, each with its title) is one the judge applies from the case alone. |
| `run_gate.py` | Starts the two model runs per task and writes down what they said; it decides nothing. `run` does it all in one process (a person's machine); `prepare`, `judges` and `collect` split it for CI, where the model's credential sits in steps that run no script of this repository. `score` prints a table; `left` counts what is not run yet. |
| `deck-slice.sh` | The slice on a pull request into staging, run on the Deck by its hub on the Deck's own Claude login (no model key in a pull_request workflow): it builds the head, runs the slice with this folder's harness taken from staging (never the pull request's) and posts the commit status `unb-208/task-slice`. |
| `fixtures/hand-audits-2026-11-18.json` | The seven answers the checks called confidently wrong on 17-18 Nov, with what a person found on each site; the bank's checks must agree with them (`test_run_gate.py`). |
| `slice.json` | The 20 tasks selected for PR and staging CI: 12 cold tasks, five browserless warm tasks, and three fresh-account reads on public practice sites. It records prior verdicts where measured and marks the remaining cases `new`. |
| `promoted.json` | The last promoted build's verdict per task and its pass count: the floor. Empty until the first promotion under the gate; `promotion_gate.py record` writes it, in a pull request Lewis approves. |
| `promoted-1k.json` | The bench's floor: the last promoted build's run of the top 1,000 sites, on the runner kind the release runs on (`runner`), its right count, confidently wrong count over answered, and each task's verdict (the rerun reads them). Not yet recorded: until it is, the release gate refuses. `promotion_gate.py record-1k` writes it from a run's `results.jsonl` and `meta.json` once every task has a measured verdict, in a pull request Lewis approves. |
| `rereads.json` | Hand re-reads: `{"id", "answer_sha", "finding", "by", "date", "note"}`, finding one of `not_a_regression`, `regression`, `check_fault`, `confirmed_wrong`. A re-read clears or confirms exactly one answer (its `answer_sha`, from `promotion_gate.py`). |
| `fixtures/staging-2026-11-17/` | Staging 7071ae02 as measured on 17 Nov 2026 (programme 887958 step 1): the coverage summary and the 22 bank results. The gate must refuse it (promotion-gate.yml checks that on every pull request). Those 22 results were scored by the check's rule, before the judge existed. |

`--first N` takes the first N sites in the bank's order (rank order for the bench); `--shard i/n` (i from 0) the sites
at positions i, i+n, i+2n...: every task is in exactly one of n shards, each warm twin in its cold task's. `run`,
`prepare` and `left` resume from `--out`: a task already there is not run again unless it hit infrastructure. Every
result carries `cost` (`client_usd`, `client_s`, `judge_usd`, `judge_s`, from each model run's own report; `null` when a
run said nothing, counted by `score` as UNMEASURED, never as free), and `score` sums them per run and per task.

Outcomes: `right`, `set_aside` (the site blocked it; never a pass), `confidently_wrong` (answered, the judge found the
check unmet; must be 0), `unfinished` (the page needed clicks the agent did not finish), `honest_fail`, `error` (no final
answer), `infra` (no server, no verdict from the judge, or the model's own credential refusing the ask: rerun, never
scored). A credential's refusal (`usage limit reached`, a spent balance, a refused key) is the run's, not the site's: that
task is `infra`, and `run` stops at the first one naming it, so a spent window costs one ask instead of every task behind
it (26 Nov 2026: run 45750120438 filed 1,970 task errors whose every ask was the same refusal).

A **rate limit** (`429`, `too many requests`, `overloaded`) is the one refusal a wait fixes, so the ask is waited out and
asked again, each wait twice the last to a 300 s cap: `GATE_RETRY_TRIES` (default 4) and `GATE_RETRY_BASE_S` (default 5)
set it. An ask still limited after every wait is `infra` — a rerun retries it — and the run goes on, because one lane's
congestion is not the next lane's verdict.

Where it runs:

- `.github/workflows/gate-bank.yml`: the slice on every push to staging and main (called by QA, `qa.yml`, so its verdict
  is in QA's report beside every journey; not again for a push to staging whose tree already passed the slice on its
  pull request, `.github/qa/passed_on_pr.py`, UNB-166), the whole bank nightly and on every push to a
  release branch (the run the promotion gate reads, artifact `gate-bank-full-<tree>`), either by hand. No pull request
  starts it, because a workflow that holds a model's credential takes no pull-request trigger.
- The Deck's hub (routine "UNB-208 task slice"): `deck-slice.sh` on each new head of a pull request into staging, the
  status `unb-208/task-slice`. Making that status required in branch protection is Lewis's call.
- `.github/workflows/gate-bank.yml`, scope `top1k` (UNB-307): the bench in `shards` jobs side by side on one pinned kind
  of runner, each keeping `gate-bank-top1k-<tree>-<i>of<n>`. Each shard runs once more, on fresh nodes
  (`start-rounds.sh`), every task whose verdict measured nothing or is not the floor's, with its twin (`run_gate.py
  again`, then `prepare --again`); the second verdict counts. One job then judges every shard together with
  `promotion_gate.py check --top1k-only` and keeps `gate-1k-<tree>` (results, `meta.json`, `rereads.json`, verdict).
  `gate-1k.yml` runs it on every push to a release branch (25 shards), and promotion-gate.sh reads it before a release
  ships. The rule (Lewis, 25 Nov 2026): rates, not every task. Refused when fewer are right than on the floor, when the
  confidently wrong rate is above the floor's, or when the run did not measure every task (a skipped shard, a task still
  infra or error after its run again, a changed verdict never run again, another kind of runner than the floor's).
- `.github/workflows/promotion-gate.yml`: on every pull request, the gate's tests and its refusal of the 17 November
  baseline; on a pull request into main, the gate's verdict on the release branch's tree.
- `.github/workflows/release.yml`: the gate before a `vX.Y.Z` tag publishes (`.github/scripts/promotion-gate.sh`).

By hand, on a node of your own (`sh test-banks/popular-sites/scratch-node.sh <dir>`, then an MCP config naming `unb mcp`):

```sh
python3 test-banks/gate/run_gate.py run --mcp mcp.json --out results.jsonl --slice test-banks/gate/slice.json
python3 .github/scripts/promotion_gate.py check --tasks-only --bank-results results.jsonl --slice test-banks/gate/slice.json
python3 test-banks/gate/run_gate.py run --mcp mcp.json --out top1k.jsonl --bank test-banks/popular-sites/top-1000.json --first 5
```

The gate is not how a site is investigated: a site that fails here is driven by hand, one call at a time, and a
changed verdict is re-read by hand on each build before it is called a regression.
