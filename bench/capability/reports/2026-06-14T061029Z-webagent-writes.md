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

## Why (the honest read — refined by an extended-budget retry)

First pass: all 6 hit the CLI's default 38 s in-process cap (`(budget_ms ?? 8000) + 30000`). That cap
is tunable via `UNBROWSE_API_TIMEOUT_MS`, so I re-ran the cleanest write case (the httpbin HTML form)
at 120 s to separate "budget too short" from "can't write at all."

**Result of the retry: it COMPLETED (no timeout) and STILL performed no write.** The capture path
waited for an XHR API matching `[post, tweet, timeline, status]` — a plain `<form method=post>` fires
no XHR, so none appeared (3 HAR, 0 bodies) — then fell back to **dom-fallback GET** and executed a
**GET of the form page**, returning the form HTML with `success:false, error:"schema_drift_recapture_required"`.

So the gap is **architectural, not a timeout**: unbrowse 9.0.5's capture/execute is **XHR/API-replay
oriented** — it discovers and replays API endpoints. It does **not** fill + submit an HTML form, and
has no path to synthesize a POST/PUT body from intent and execute it. `resolve` auto-executes the top
**safe GET** only; non-safe writes are correctly gated, and nothing downstream turns a write intent
into a write request. This is the honest shape of the product: a strong read/replay engine (core
Axis B two-witness GET PASS), not yet a write/action agent.

- **Secondary finding (real, now FIXED in code):** the shipped CLI calls backend `POST /v1/validate`
  which **404s** — `publicValidateRoutes` was imported in `backend/src/index.ts` but never mounted, so
  validation silently "proceeded unvalidated". Mounted (witness `backend/tests/validate-route-mounted.test.ts`);
  takes effect in prod on the next backend deploy.

## What this means for a webagent benchmark

The dedicated webagent-write suites (WASP / ST-WebAgentBench / AgentDojo / InjecAgent) are **not
cloned** in this tree (only `exa` + `browsecomp` vendored) and need hosted controlled environments;
they are reported BLOCKED, not faked. This probe substitutes 6 real public write-safe endpoints to
measure the capability directly — and the measured answer is that **write actions are an honest
capability gap in 9.0.5**, distinct from the strong read/replay path.

## Update — write EXECUTION now works (a bug, fixed); the gap narrows to discovery + selection

Probing the execute machinery directly (`executeSkill` against a POST endpoint with a body) revealed
the real blocker: the execute path ran a **HEAD pre-probe** before the request, and HEAD against a
write-only endpoint **404s legitimately** → `decideFromProbe` misread it as a stale route and aborted
**before the POST was ever sent**. Fixed: write methods (POST/PUT/PATCH/DELETE) now skip the
GET-oriented HEAD probe and `serverFetch` the real method + body. **Witness:**
`tests/write-action-execute.test.ts` — a live POST to postman-echo now round-trips (the body crosses
the wire, the response schema is learned). So the write *execution* layer is capable; the auto-exec
unsafe-action gate upstream still prevents writes without a deliberate caller action.

**The remaining write gap is no longer execution — it is discovery + selection:**
1. **Discovery**: capture is XHR-replay oriented, so a plain HTML `<form method=post>` (no XHR) is
   never indexed as a write route. Form-fill+submit-during-capture is the missing piece.
2. **Selection**: `resolve`/`run` auto-execute the top *safe GET* only; an agent write intent has no
   path to pick + execute an indexed POST/PUT (behind the unsafe-action confirm).
3. Clone a real webagent-write suite into `bench/*/vendor/` and grade against its controlled app
   (agentdojo / InjecAgent / wasp cloned; they need their own agent harness + hosted env to run).
4. ✅ `/v1/validate` 404 fixed (route mounted); staging deployed, prod re-trigger pending.
