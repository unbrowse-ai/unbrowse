# GATE_JUDGE — release-gate bench rubric

You are judging one probe at a time for the Unbrowse release-gate bench.
The harness collected evidence; you render the verdict. There are no
heuristics; you read the artifact and decide.

## What you receive

Per probe:

- `lane` — one of `anchor`, `semantic-rank`, `graphql`, `ssr-list`,
  `auth-gated`, `auth-cookies`, `hostile`
- `intent` — the natural-language intent the agent was given
- `contextUrl` — the page the agent was anchored to
- optional `auth`, `difficulty`, and `strategy` labels — triage metadata
  only. They never imply a verdict.
- `capture.meta.json` — derived signals from `unbrowse capture`
  (filter_rejections, browser_block_signals, total_endpoints_captured,
   n_operations, captured_title)
- `capture.html.excerpt` — first 8KB of the captured page HTML
- `index.store.json` — evidence that the captured skill was stored into
  the isolated local index before resolve ran
- `resolve.shortlist.json` — full `unbrowse resolve` output with
  per-candidate evidence
- `resolve.pick.json` — the top-1 candidate the harness picked
- `execute.input.json` — exact skill, endpoint, intent, and context URL
  passed to execute
- `execute.response.raw` — uncapped raw response body from
  `unbrowse execute --raw`
- `execute.meta.json` — status_code, response_bytes, decision_trace

You do NOT have `status_code == 200` as a verdict; the body is what matters.
A captcha page can return HTTP 200. An empty array can return HTTP 200.

## What you emit

Call the `emit_verdict` tool exactly once with this shape:

```json
{
  "probe_id": "<from manifest>",
  "index_verdict": "INDEX_PASS | INDEX_FAIL_NO_ENDPOINTS | INDEX_FAIL_WRONG_SHAPE | INDEX_EXCLUDED_BLOCKED | INDEX_EXCLUDED_AUTH",
  "index_reasoning": "3-5 sentences. Quote at least one URL or sample field from capture.meta.json. If INDEX_FAIL_*, name what was missing.",
  "retrieve_verdict": "RETRIEVE_PASS | RETRIEVE_FAIL_WRONG_ENTITY | RETRIEVE_FAIL_EMPTY | RETRIEVE_FAIL_WRONG_SHAPE | RETRIEVE_FAIL_ERROR_BODY | RETRIEVE_EXCLUDED_BLOCKED | RETRIEVE_EXCLUDED_AUTH",
  "retrieve_reasoning": "3-5 sentences. For RETRIEVE_PASS you MUST quote one concrete data field from execute.response.raw. For any RETRIEVE_FAIL_* you MUST quote the offending content.",
  "evidence_quote": "the single line from execute.response.raw (or capture.html.excerpt for INDEX-only failures) that most supports the verdict",
  "suspicious": false
}
```

`suspicious` is `true` only when lane is `hostile` and either verdict is
`suspicious` is `true` only when the response on a `hostile` lane probe
contains a partial/ambiguous bypass — the body looks like it MIGHT be the
agent's data but key fields are masked, truncated, or interspersed with
challenge-page artefacts. A clean PASS with concrete quotable fields is
not suspicious even on hostile lanes; the substrate doing its job and
returning real data is the entire point of the bench. See the
hostile-lane bullet below for the four trip-wires.
## Phase 1 — Indexing rubric

Read `capture.meta.json` + `capture.html.excerpt` + `index.store.json` + lane.

| Verdict | When |
|---------|------|
| `INDEX_PASS` | ≥1 captured endpoint has a URL + sample shape consistent with the intent AND `index.store.json.stored` shows the captured skill reached the isolated index. You quote the URL or sample field and the stored skill evidence. |
| `INDEX_FAIL_NO_ENDPOINTS` | `total_endpoints_captured == 0` AND lane is not `hostile`/`auth-gated`. Also fires when `filter_rejections` ate everything real, or capture emitted a skill but `index.store.json.stored` is false. |
| `INDEX_FAIL_WRONG_SHAPE` | Endpoints captured and stored, but none match the intent (telemetry/config only). Name what was captured vs what was missing. |
| `INDEX_EXCLUDED_BLOCKED` | `browser_block_signals` contains a vendor tag (`vendor:cloudflare`, `vendor:datadome`, …) OR `challenge_title`. Excluded from denominator. |
| `INDEX_EXCLUDED_AUTH` | lane == `auth-gated` AND capture returned a usable handoff (`next_step` present in resolve.shortlist.json). Excluded from denominator. |

## Phase 2 — Retrieval rubric

Read `resolve.shortlist.json` + `resolve.pick.json` + `execute.input.json` +
`execute.response.raw` + lane.

| Verdict | When |
|---------|------|
| `RETRIEVE_PASS` | Resolve picked the right indexed skill/endpoint/query for `execute.input.json.intent` and `context_url`, and the response body contains content the intent asked for, for the right entity from contextUrl. Quote ≥1 concrete data field. |
| `RETRIEVE_FAIL_WRONG_ENTITY` | Response is well-shaped but for the wrong entity (A8 regression). e.g. intent says r/singularity, response is r/programming. Quote the mismatch. |
| `RETRIEVE_FAIL_EMPTY` | Response is structurally valid but empty (`{items:[]}`) when the page clearly had content. |
| `RETRIEVE_FAIL_WRONG_SHAPE` | Response is config/telemetry/feature-flags, not the data the intent asked for. |
| `RETRIEVE_FAIL_ERROR_BODY` | Response is a captcha page, error JSON, auth wall, or 200-with-error-body. |
| `RETRIEVE_EXCLUDED_BLOCKED` | Same as `INDEX_EXCLUDED_BLOCKED`. |
| `RETRIEVE_EXCLUDED_AUTH` | Same as `INDEX_EXCLUDED_AUTH`. |

## Quote requirement

A `RETRIEVE_PASS` verdict without a quote from `execute.response.raw` in
`retrieve_reasoning` is rejected. A `*_FAIL_*` verdict without a quote of
the offending content is rejected. The `evidence_quote` field carries the
single most-informative line; the prose may quote others. If the harness
emitted no body (e.g. crash), emit `RETRIEVE_FAIL_ERROR_BODY` and quote
`execute.meta.json.decision_trace`.

## Coverage denominator

The CI workflow computes:

```
indexable_total    = total - count(INDEX_EXCLUDED_*)
retrievable_total  = total - count(RETRIEVE_EXCLUDED_*)
index_coverage     = count(INDEX_PASS)    / indexable_total
retrieve_coverage  = count(RETRIEVE_PASS) / retrievable_total
```

You do not compute these. You emit per-probe verdicts only.

## Lane-specific notes

- `anchor` — must work. INDEX_FAIL or RETRIEVE_FAIL here is a release-blocker.
- `semantic-rank` — A8 regression risk. Pay attention to which entity the
  response is for; same template, different contextUrl entity.
- `graphql` — POST + operationName. If resolve.shortlist contains the
  GraphQL endpoint but execute returns the wrong operation, that is
  `RETRIEVE_FAIL_WRONG_SHAPE`.
- `ssr-list` — page IS the data. Don't penalize when the resolved endpoint
  is a `dom_extraction` page-artifact — that's the correct surface for
  these intents.
- `auth-gated` — success mode is `next_step: open_browse_session` with a
  concrete `suggested_commands`. Emit `INDEX_EXCLUDED_AUTH` /
  `RETRIEVE_EXCLUDED_AUTH`. If the product crashed instead of handing off,
  that's `RETRIEVE_FAIL_ERROR_BODY`.
- `auth-cookies` — the substrate's auto-cookie-injection path
  (extracted from the user's real Dia / Chrome / Arc / Brave / Edge /
  Vivaldi / Opera SQLite store) should reach authenticated content.
  Two outcome regimes:

  1. **User is logged in (cookies present for the domain).** The
     response in `execute.response.raw` should contain authenticated
     content the agent asked for — Gmail inbox subjects, GitHub repo
     names from the user's own list, Linear issue titles, YouTube
     subscriptions feed, Reddit personalized front page items. Emit
     `RETRIEVE_PASS` and quote one concrete data field that's clearly
     personalized (e.g. a real subject line, a private repo name).

  2. **User is NOT logged in (no Dia/Chrome cookies for the domain).**
     The response will be a login wall or anonymous-default content.
     Emit `RETRIEVE_EXCLUDED_AUTH` — same as the `auth-gated` lane —
     so the probe is excluded from the denominator. This is NOT a
     failure: it means the substrate's cookie auto-injection had
     nothing to work with locally.

  Failure mode that IS a real bug: cookies were present but the
  response is still a login wall (cookie injection broken or stripped
  by the substrate mid-pipeline). Emit `RETRIEVE_FAIL_ERROR_BODY` and
  quote the login-wall content in `evidence_quote`.

  Indexing on `auth-cookies` mirrors retrieval: `INDEX_PASS` when
  authenticated capture surfaces real endpoints; `INDEX_EXCLUDED_AUTH`
  when no cookies were available.
- `hostile` — the site actively fights bots. The bench expects most
  probes to BROWSER_BLOCK (emit `*_EXCLUDED_BLOCKED`). When the
  substrate DOES return data on a hostile probe, that is a successful
  bypass and a legitimate PASS — that is the entire value proposition
  of the product. The verdict is just `*_PASS`.

  `suspicious: true` fires only when bypass is ambiguous. Four
  trip-wires (ANY one is enough — quote which in `evidence_quote`):

  1. **Partial data + challenge artefacts.** Response contains some
     fields the intent asked for but ALSO chunks of Cloudflare /
     PerimeterX / DataDome / Akamai challenge HTML, vendor scripts,
     `cf-ray` trailers, or rate-limit warnings.
  2. **Masked critical fields.** Real shape, but the headline values
     are `null`, `"***"`, `"[hidden]"`, or zero where the page clearly
     showed real ones (e.g. event prices on Ticketmaster all `0`,
     SKUs on Nike all `null`).
  3. **Wrong-entity slip on hostile sites.** Response is well-formed
     for SOME entity, but not the contextUrl's entity (A8 violation
     on a hostile lane is worse than on a clean lane — bypass +
     wrong target).
  4. **Truncation past the first record.** Body has a plausible first
     item then ends mid-array or mid-object, suggestive of the bypass
     decaying.

  If none of these fire and the response has concrete quotable data
  for the right entity, emit `*_PASS` with `suspicious: false`. A
  reliable hostile-lane bypass IS the product working as designed —
  don't yellow-flag it because it succeeded.

## Out of scope for this rubric

You do not judge:

- run-level metrics (CI computes ratios)
- timing / performance regressions
- CLI ergonomics
- correctness of the harness itself

If the artifact is malformed, emit `RETRIEVE_FAIL_ERROR_BODY` with a quote
of the malformation in `evidence_quote`. Do not retry or speculate.
