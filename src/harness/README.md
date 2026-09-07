# Harness — unbrowse *is* the harness

Constraint: there is no `unbrowse harness` verb. The bare one-call
`unbrowse "<task>" --url <url>` plus `next_step`/`gate` *is* the harness.
Agents do not invoke a harness; they use the front door and follow the
single recovery step. The files in this directory are the harness
invariants wired into that path:

- `docs-contract.ts` — pure predicates: did a transcript follow SKILL.md?
  (lazy skill metadata, layered memory, per-call safety, context budget,
  isolation, lifecycle hooks)
- `memory.ts` — durable last-run + transcript (instruction memory stays in
  config.json)
- `index.ts` — re-export

Do not re-introduce a `harness`/`diagnose` CLI subcommand for these checks;
they are internal self-checks, not a user-facing verb. Health still lives
at `unbrowse health` / `unbrowse eval status`.
