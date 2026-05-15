# Agent-Judged Contract

The loop has four evidence questions:

1. Indexed: did capture discover a route or page artifact matching the intent?
2. Stored: did `index.store.json` prove the captured skill reached the isolated index?
3. Retrieved: did resolve select the right skill, endpoint, query, and entity for `execute.input.json`?
4. Executed: did `execute.response.raw` contain the requested content for the right entity?

Only Codex answers these questions by reading artifacts. Scripts may collect, format, validate, compare, and triage.

Forbidden shortcuts:

- `status_code == 200` as success.
- Lane metadata as exclusion without artifact evidence.
- A unit test pass as bench coverage.
- Dry-run verdicts as release evidence.
