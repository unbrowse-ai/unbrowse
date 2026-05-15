# Fix Loop

1. Read `gate.md` and `improvement-plan.md`.
2. Pick the highest-leverage failing cluster, usually anchor first, then shared strategy failures.
3. Inspect all listed artifacts before editing.
4. Identify root cause:
   - capture did not discover the endpoint
   - index did not store the skill
   - resolve picked the wrong endpoint
   - execute used wrong params or stale route
   - extraction returned wrong shape or wrong entity
5. Patch the shared primitive, not the single domain, unless the domain exposes a public canonical API.
6. Add a focused regression guardrail test for the primitive.
7. Rerun focused tests.
8. Rerun a small bench slice and rejudge from artifacts.
9. Repeat until full agent-judged compare passes.
