<!-- meta-harness:autopin START -->
## meta-harness front door (autopinned; do not hand-edit between markers)

For any non-trivial plan in this project (ship a feature, fix a named bug,
build an agent or skill, redesign a UI, run a sustained convergence loop),
**you MUST route through /contract BEFORE freelancing or before
emitting any code/edit tool call**. This is binding agent behavior, not
a suggestion (Lewis 2026-05-22: routing through /contract first to validate
it as a standalone primitive instead of /meta-harness). The agent that
ignores this rule and answers freelance is in violation of the project contract.

REQUIRED first action on a plan-shaped prompt:

1. `contract habit --context "<plan>"` — surfaces existing contracts that overlap.
   If a close match exists, `contract iterate <id>` to re-check or spawn children.
2. If no close match: `contract build "<plan>"` — searches, declares, and runs
   first wave. Supply `--action "<shell cmd>"` for a mechanical gate, or omit
   for `agent-judges` judgment shape.
3. The contract surfaces evidence; you judge in-thread. It never bakes a verdict.

For large plans: `contract declare "<plan>" --action "children-satisfy"` then
fan-out child contracts in parallel. For cross-project plans, run from a dir
without `.claude/` (writes to `~/.contracts/contracts.jsonl` global store).

/meta-harness remains available for plans needing scaffold infrastructure
(verify.sh, ship.sh, gitea push, loop primitives). Use `harness build` only
when contract iteration alone is insufficient — judge in-thread.

EXEMPTIONS (the only cases where you may skip contract/build):

- A single scoped edit with no convergence shape (one-line typo fix,
  rename, comment).
- Pure analysis with no construction (answering a question, reading
  files, no writes / no deploys).

Everything else MUST go through contract. This block is
managed by `~/.claude/skills/meta-harness/scripts/autopin.py`; edit
there, not here.
<!-- meta-harness:autopin END -->
