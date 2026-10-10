# How Unbrowse works

Unbrowse compiles websites into APIs, and APIs into tools agents call. A site is browsed once;
after that, the task replays the site's own first-party HTTP requests without a browser.

Everything below runs in the hosted service. The client in this repo (`@unbrowse/sdk` and the
`unbrowse` CLI) only sends REST calls to `/api/v1`; agents drive the cloud browser through the
hosted MCP.

## The two passes

**Pass 1 — learn.** No capability fits the task. The agent opens a recorded cloud browser
(MCP `unbrowse_browse_open`), does the task, and finishes (`unbrowse_browse_finish`). Recording is on
from the first navigation, so the task is done *and* captured. Unbrowse then:

- groups the recorded requests into families and drops pixels, analytics and polling;
- diffs two sessions with different inputs to find which request fields are the inputs;
- traces every token and id (CSRF, quote tokens, selected ids) back to the response that
  produced it, so a multi-step flow replays as one call;
- names the inputs from the `name` the agent gave each filled field (`origin`, `date`, `query`).

The result is a `learned.*` capability: a versioned `unbrowse/v1alpha1` harness (YAML) plus a
generated SKILL.md. Two HAR exports of the same task work too (`unbrowse learn a.har b.har`).

**Pass 2 — replay.** A run (`unbrowse run`, `POST /api/v1/runs`) routes the task to a capability and replays its requests over
plain HTTP with the new inputs. No browser. A run is `succeeded` only when the declared outcome is
verified; HTTP 200 alone is not success.

If what the agent typed never reached a replayable request (client-side filtering, a third-party
search widget), learning says so (`typed_input_unused`) and nothing is indexed. The task was still
done.

## Capability states

Each capability returned by `discover` carries hints:

| Hint | Meaning |
|---|---|
| `state: warm` | Replays over HTTP. Fast. |
| `state: rendered` | Needs a page render in a browser. Slower. |
| `state: cold` | Never run. |
| `health` | healthy, degraded, failing, cooling_down, excluded, needs_sign_in, untested |
| `latencyMs` | p50 / p95 of recent runs |
| `next` | The exact call or fix to do next |

Agents follow `next` and skip `failing` or `excluded` capabilities when another fits.

## Page reads

When the task is reading a page (a profile, an article, a listing) and no API answers it,
finishing on that page learns a page read: the input is the part of the URL that changes. It runs
over plain HTTP when the server sends the content in its HTML.

## When a site pushes back

- **Bot checks** that clear themselves ("Just a moment…") are waited out in a headful browser.
- **Replay transport** switches a host to a browser-grade TLS fingerprint after one challenge.
- **Render fallback**: when replay cannot answer, the page is rendered, first in Unbrowse's own
  browser, then a hosted renderer. Such runs report `via: "rendered"` and any passthrough cost.

## Sign-ins

Logins live in the Unbrowse password manager ([logins-and-vault.md](logins-and-vault.md)).

- In the cloud browser, `unbrowse_browse_act` with `autofill` fills the login form from the vault. Values never
  pass through the agent.
- On replay, a 401 from a site with a saved login triggers one browser sign-in; the session is
  cached and reused until it expires.
- If no login is saved, the run carries a one-time save-login link (`signIn.url`). The CLI opens it
  and exits 3. MCP clients that support URL elicitation receive it as error `-32042`.

The MCP tool `unbrowse_sites` shows what Unbrowse knows before you act: public or behind a sign-in, the
kept session (active / expired / logged_out / none), last sign-in, saved login, learned tools and
bot checks.

## Private space and the public registry

`discover` searches your workspace's private capabilities first, then the public registry.

Read-only, secretless routes you teach are scrubbed and shared to the public registry by default
(opt out in the console; logins and writes are never shared). A route is published only after a
scrubbed copy, with no cookies, answers fresh queries and fails a nonsense one.

Every compiled site is also:

- an MCP server: `/api/v1/sites/<host>/mcp`
- an OpenAPI 3.1 document: `/api/v1/sites/<host>/openapi.json`

Your own tools appear in `tools/list` as `my__<site>__<op>`.

## Runs

A run is durable. Statuses:

| Status | Meaning | CLI exit |
|---|---|---|
| `accepted`, `working` | In progress; the CLI polls `inspect` | — |
| `succeeded` | Verified result | 0 (4 if `verified: false`) |
| `input_required` | Needs answers; `resume` on the **same** run | 2 |
| `outcome_unknown` | A change may have happened; do not retry blindly | 4 |
| `failed` | Failed; `error` says why | 1 |

`cancel` stops new dispatches and returns a receipt of dispatched, uncertain and unstarted effects.

## Routing

When several capabilities could answer, the service picks among eligible ones with a typed
judgment model (Jev) when configured, and deterministic ranking otherwise. Routes come only from
observed traffic; a model never writes a URL that gets replayed.
