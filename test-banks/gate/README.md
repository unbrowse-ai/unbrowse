# The task gate's bank (UNB-208)

Staging is promoted to public only with 90% line coverage in every gated part and no task lost (AGENTS.md, "Tests,
requirements and the merge scorecard"). This folder is the task half: a fixed bank of real tasks, run through a
scratch node's MCP with a real model as the client and as the judge.

| File | What it is |
|---|---|
| `bank.json` | The 91 tasks: three searches on the staging criteria's own sites (lazada.sg, carousell.sg, ticketmaster.com; the judge reads each answer for five results with name, price or date, and link), 75 from the unbrowse6 coverage bank (unbrowse6 8b7ff88, not deferred, a deterministic check, passed at least once, no wall expected) and one per site of the Lundy nightly set (13). The pick rule is in `pick_rule`; Lewis approves the bank. |
| `prompt.md`, `judge.md` | What the client is asked (the unbrowse6 harness prompt) and what the judge is asked. |
| `run_gate.py` | Starts the two model runs per task and writes down what they said; it decides nothing. `run` does it all in one process (a person's machine); `prepare`, `judges` and `collect` split it for CI, where the model's credential sits in steps that run no script of this repository. `score` prints a table; `left` counts what is not run yet. |
| `deck-slice.sh` | The slice on a pull request into staging, run on the Deck by its hub on the Deck's own Claude login (no model key in a pull_request workflow): it builds the head, runs the slice with this folder's harness taken from staging (never the pull request's) and posts the commit status `unb-208/task-slice`. |
| `fixtures/hand-audits-2026-11-18.json` | The seven answers the checks called confidently wrong on 17-18 Nov, with what a person found on each site; the bank's checks must agree with them (`test_run_gate.py`). |
| `slice.json` | The nine tasks the short run takes, with the verdict each had on its reference build: six that were right on 17 Nov, and one search each on lazada.sg, carousell.sg and ticketmaster.com, the sites the staging criteria name (the bank's part C). |
| `promoted.json` | The last promoted build's verdict per task and its pass count: the floor. Empty until the first promotion under the gate; `promotion_gate.py record` writes it, in a pull request Lewis approves. |
| `rereads.json` | Hand re-reads: `{"id", "answer_sha", "finding", "by", "date", "note"}`, finding one of `not_a_regression`, `regression`, `check_fault`, `confirmed_wrong`. A re-read clears or confirms exactly one answer (its `answer_sha`, from `promotion_gate.py`). |
| `fixtures/staging-2026-11-17/` | Staging 7071ae02 as measured on 17 Nov 2026 (programme 887958 step 1): the coverage summary and the 22 bank results. The gate must refuse it (promotion-gate.yml checks that on every pull request). Those 22 results were scored by the check's rule, before the judge existed. |

Outcomes: `right`, `set_aside` (the site blocked it; never a pass), `confidently_wrong` (answered, the judge found the
check unmet; must be 0), `unfinished` (the page needed clicks the agent did not finish), `honest_fail`, `error` (no final
answer), `infra` (no server, or no verdict from the judge: rerun, never scored).

Where it runs:

- `.github/workflows/gate-bank.yml`: the slice on every push to staging and main (called by QA, `qa.yml`, so its verdict
  is in QA's report beside every journey; not again for a push to staging whose tree already passed the slice on its
  pull request, `.github/qa/passed_on_pr.py`, UNB-166), the whole bank nightly and on every push to a
  release branch (the run the promotion gate reads, artifact `gate-bank-full-<tree>`), either by hand. No pull request
  starts it, because a workflow that holds a model's credential takes no pull-request trigger.
- The Deck's hub (routine "UNB-208 task slice"): `deck-slice.sh` on each new head of a pull request into staging, the
  status `unb-208/task-slice`. Making that status required in branch protection is Lewis's call.
- `.github/workflows/promotion-gate.yml`: on every pull request, the gate's tests and its refusal of the 17 November
  baseline; on a pull request into main, the gate's verdict on the release branch's tree.
- `.github/workflows/release.yml`: the gate before a `vX.Y.Z` tag publishes (`.github/scripts/promotion-gate.sh`).

By hand, on a node of your own (`sh test-banks/popular-sites/scratch-node.sh <dir>`, then an MCP config naming `unb mcp`):

```sh
python3 test-banks/gate/run_gate.py run --mcp mcp.json --out results.jsonl --slice test-banks/gate/slice.json
python3 .github/scripts/promotion_gate.py check --tasks-only --bank-results results.jsonl --slice test-banks/gate/slice.json
```

The gate is not how a site is investigated: a site that fails here is driven by hand, one call at a time, and a
changed verdict is re-read by hand on each build before it is called a regression.
