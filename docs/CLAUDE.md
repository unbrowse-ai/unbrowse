<!-- meta-harness:autopin START -->
## meta-harness front door (autopinned; do not hand-edit between markers)

For any non-trivial plan in this project (ship a feature, fix a named bug,
build an agent or skill, redesign a UI, run a sustained convergence loop),
**you MUST route through meta-harness BEFORE freelancing or before
emitting any code/edit tool call**. This is binding agent behavior, not
a suggestion (Lewis 2026-05-20: "harness it so that i dont have to say
harness it"). The agent that ignores this rule and answers freelance is
in violation of the project contract.

REQUIRED first action on a plan-shaped prompt:

1. `bash ~/.claude/skills/meta-harness/scripts/harness discover` — surfaces
   every callable past harness in this project AND every global harness.
   If a past harness's plan_text matches the current request closely
   (agent judges similarity in-thread), `harness iterate <slug>` it
   instead of building new.
2. If no close match: `harness build "<plan>"`. Add `--global` when the
   harness is cross-project (integration with an external service,
   reusable tool surface, research loop).
3. The harness surfaces evidence; you judge in-thread. It never bakes a
   verdict, a banned list, or a per-case rule into the substrate.

EXEMPTIONS (the only cases where you may skip discover/build):

- A single scoped edit with no convergence shape (one-line typo fix,
  rename, comment).
- Pure analysis with no construction (answering a question, reading
  files, no writes / no deploys).

Everything else MUST go through harness. If you find yourself about to
freelance a multi-step task, STOP and run discover first. This block is
managed by `~/.claude/skills/meta-harness/scripts/autopin.py`; edit
there, not here.
<!-- meta-harness:autopin END -->
