---
active: true
iteration: 4
max_iterations: 50
completion_promise: "ALL_SCAFFOLDS_CONVERGED"
started_at: 2026-05-21T00:32:41Z
---

Drive every `.claude/*.local.md` scaffold whose frontmatter `status:` is not `converged` to convergence, end to end. Each iteration:

1. List target scaffolds: `ls .claude/*.local.md` and read each
   frontmatter `status:`. A scaffold is at TERMINAL status when
   `status:` is one of `converged`, `blocked`, or `out-of-scope`
   (skip terminal scaffolds; iterate the rest). `deferred` is NOT
   terminal — see rule 4.
2. For the first non-terminal scaffold, run its declared driver:
   `bash .claude/<slug>/scripts/iterate.sh` (add `--gates --gates-baseline HEAD~5` if the plan is shipping to main).
3. Read that scaffold's `.claude/<slug>/ledgers/iterations.jsonl` (latest
   row), `gates.jsonl` (substrate-audit always runs), and `lanes.jsonl`.
   JUDGE in-thread per the inherited substrate principle
   (`references/SUBSTRATE-PRINCIPLE.md`): is the phase goal met, are gate
   rows clean, did verify pass? Harness collects; you judge. Never trust a
   script's PASS/FAIL.
4. Pick a TERMINAL status honestly:
   - `converged` -> phase goal met and evidence clean.
   - `blocked`   -> external dependency missing (API key, backend gate,
                      human approval). MUST cite the exact missing dep.
   - `out-of-scope` -> the scaffold's plan_text was overtaken / no longer
                         a real goal. MUST cite what replaced / superseded it.
   - `deferred` is NOT a terminal status. Lewis 2026-05-20: "harness so
     deferred is never deferred." If the scaffold body is a stub, the
     loop must AUTHOR the implementation IN-LOOP using the iteration_cap
     budget. Mark `deferred` only AS A WAYPOINT inside one iteration to
     remind the next iterate to pick up; the next iterate must promote
     it to one of the real terminal statuses or keep authoring.
5. If a wave failed, read `logs/iter<N>-<phase>.log` (row.error_excerpt
   points at it), fix the one named regression, commit, iterate again.
6. Honor the peer-collision guardrail: before editing a peer-contended
   file run `~/.claude/skills/meta-harness/scripts/principle-queue.sh
   propose-if-locked`; enqueue instead of conflicting.

RECORRECTION RULE (Lewis 2026-05-20): if you find yourself about to
`harness-loop.sh cancel` because a stub cannot converge, STOP. The
substrate-faithful options are, in priority order: (1) author the
missing implementation IN-LOOP (the iteration_cap budget exists for
this); (2) mark the scaffold `blocked` ONLY if a concrete external
dependency is missing and cited; (3) surface the choice to the user.
NEVER cancel unilaterally; never use `deferred` as a permanent escape.

When ALL target scaffolds have one of the TERMINAL statuses above AND
no scaffold's latest gate row shows an unresolved violation, output
exactly this on its own line and nothing will re-loop:

<promise>ALL_SCAFFOLDS_CONVERGED</promise>

Do not emit the promise tag until every target scaffold is actually at
a terminal status by your own honest judgment. Emitting it early ends
the loop with work unfinished.
