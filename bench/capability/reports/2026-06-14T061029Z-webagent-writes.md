# webagent write/auth probe — 2026-06-14T061029Z

**Companion to** `2026-06-14T055808099Z.md` (the four-axis capability report). This probe is the
new write/auth axis: beyond the read/GET coverage the core report grades, does the shipped CLI
perform **POST / PUT / authenticate-then-act** actions? Graded on the npm-shipped **9.0.5** binary
(`UNBROWSE_BIN=/tmp/unbrowse-shipped`), agent-judged from raw artifacts (no heuristic verdict).

## Targets (6 real write-safe endpoints)

| id | url | action |
|----|-----|--------|
| post-echo | postman-echo.com/post | POST a JSON body |
| put-echo | postman-echo.com/put | PUT a JSON body |
| jsonph-create | jsonplaceholder.typicode.com/posts | POST create (201) |
| reqres-register | reqres.in/api/register | POST register → token |
| auth-then-act | httpbin.org/bearer | bearer-auth then read identity |
| form-submit | httpbin.org/forms/post | fill + submit an HTML form |

## Result — HONEST NEGATIVE: 0/6 write actions completed

Every target returned `{"error":"cli_timeout","message":"In-process API exceeded 38000ms"}` with
`run_plan:[{step:"resolve",mode:"direct_or_cached",status:"miss"}]`. The agent `run` path:
1. **resolve missed** — no indexed route for the write intent (expected: these are write APIs/forms
   with no pre-indexed POST/PUT endpoint),
2. **escalated to browser capture** — CDP captured the page (e.g. 3 HAR entries, 0 bodies),
3. **hit the CLI's own 38 s in-process budget** before synthesizing+executing a write → `cli_timeout`.

No POST, PUT, form-submit, or authenticate-then-act completed. This is not a probe-timeout artifact
(my wrapper allowed 120 s) — it is the CLI's **internal 38 s in-process cap**: a write requiring
browser capture + form-fill + submit does not finish inside it.

## Why (the honest read)

- unbrowse 9.0.5 is a **read/GET-replay engine**. Its strength (core report Axis B: two-witness GET
  execution PASS, content-bound) is the opposite shape from a write: `resolve` **auto-executes the
  top safe GET only** — non-safe POST/PUT are gated by the unsafe-action guard (a correct safety
  property), and the `run` agent path has no fast route to synthesize a POST body + execute it, so
  it falls through to browser capture and times out.
- **Secondary finding (real):** the shipped CLI calls backend `POST /v1/validate` which **404s**
  ("remote validation unavailable … proceeding unvalidated"). Non-fatal, but a missing endpoint the
  shipped client expects.

## What this means for a webagent benchmark

The dedicated webagent-write suites (WASP / ST-WebAgentBench / AgentDojo / InjecAgent) are **not
cloned** in this tree (only `exa` + `browsecomp` vendored) and need hosted controlled environments;
they are reported BLOCKED, not faked. This probe substitutes 6 real public write-safe endpoints to
measure the capability directly — and the measured answer is that **write actions are an honest
capability gap in 9.0.5**, distinct from the strong read/replay path.

## To move the number (levers, not yet pulled)

1. A deliberate **resolve → capture(POST endpoint) → execute --skill --endpoint -p** path with a
   write body, raising the in-process cap for the write escalation (the 38 s cap is the binding limit).
2. Clone a real webagent-write suite into `bench/*/vendor/` and grade against its controlled app.
3. Fix the `/v1/validate` 404 (or stop the client calling a missing endpoint).
