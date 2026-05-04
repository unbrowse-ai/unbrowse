# Autonomous Discovery — Judging Protocol

The harness collects evidence; the agent judges. After a run completes, read
`.harness-out/autonomous-discovery/<run-id>/manifest.json` and the per-probe
JSON artifacts; do NOT grep for pass/fail strings.

The North Star claim under test: **a Kuri (or attached Chrome) session
autonomously updates skills with no explicit publish step**, AND the agent
sees those skills mid-session, AND they reach the marketplace for other
agents within seconds.

## Probes

### Probe A — in-flight resolve

**What it measures:** Can `unbrowse resolve` see traffic captured by an
active `unbrowse go` session, *before* `close` or `sync` is called?

**Artifact fields (`probe-a.json`):**
- `t_go_ms` — when `go` returned
- `t_buffer_size_pre_resolve` — number of intercepted requests in the active
  session's buffer at the moment resolve fires
- `t_resolve_ms` — when resolve returned
- `resolve.source` — `marketplace` | `local-skill-cache` | `in-flight-buffer`
  (new) | `live-capture` | …
- `resolve.has_available_operations` — bool
- `resolve.n_operations` — count
- `resolve.top_op` — `{operation_id, description}` of the first op
- `resolve_raw_path` — pointer to the full resolve JSON dump

**Verdict criteria:**
- **PASS** iff `resolve.has_available_operations == true` AND
  `resolve.source` is one of (`in-flight-buffer`, `local-skill-cache`,
  `marketplace`) AND the top op is plausibly relevant to the intent
  (you, the agent, judge that — read `top_op.description`).
- **FAIL** iff resolve returned `live-capture` (re-opened a browser),
  `no_cached_match`, or empty ops despite `t_buffer_size_pre_resolve > 0`.
- **AMBIGUOUS** iff `t_buffer_size_pre_resolve == 0` (no traffic was
  captured — separate bug, escalate, don't judge in-flight visibility on it).

### Probe B — streaming cross-agent publish

**What it measures:** Does a route captured by agent A become visible to
agent B's `resolve` *without* agent A calling `close` or `sync`?

**Artifact fields (`probe-b.json`):**
- `agent_a.email`, `agent_b.email`
- `agent_a.t_go_ms`, `agent_a.t_first_request_captured_ms`
- `agent_b.t_resolve_ms`, `agent_b.resolve.source`,
  `agent_b.resolve.has_available_operations`,
  `agent_b.resolve.n_operations`
- `t_publish_to_marketplace_ms` — server-side timestamp when the skill
  first appeared in marketplace (read from `/v1/skills?domain=…`)
- `marketplace_skill_age_at_resolve_ms` — `agent_b.t_resolve_ms -
  t_publish_to_marketplace_ms`. Negative means agent B beat publish.

**Verdict criteria:**
- **PASS** iff `agent_b.resolve.source == "marketplace"` AND
  `marketplace_skill_age_at_resolve_ms > 0` AND
  `agent_b.t_resolve_ms - agent_a.t_first_request_captured_ms < 30_000`
  (under 30 seconds end-to-end, no close).
- **FAIL** iff agent B got `no_cached_match`, `live-capture`, or marketplace
  age is null after the wait window.
- **AMBIGUOUS** iff publish-admission rejected all routes (read
  `/v1/admin/publish/recent-rejections` if available; otherwise
  `agent_a.flush_log` will show the rejection reasons).

### Probe C — auto-CDP-attach

**What it measures:** When a Chrome with `--remote-debugging-port=9222` is
already running, does `unbrowse go` attach to it instead of launching Kuri?
Does traffic from that external Chrome flow through the capture pipeline?

**Artifact fields (`probe-c.json`):**
- `external_chrome_pid` — pid of the Chrome the harness launched
- `external_chrome_debug_port` — 9222
- `t_go_ms`, `t_external_chrome_traffic_first_seen_ms`
- `kuri_pids_after_go` — array of kuri pids (should be empty/unchanged
  from before-go state for PASS)
- `attached_browser_pid` — pid the unbrowse server reports as the active
  browser (read from `/v1/admin/sessions/:id`); should equal
  `external_chrome_pid` for PASS
- `external_chrome_intercepted_requests` — count of requests from the
  external Chrome that landed in the unbrowse capture buffer

**Verdict criteria:**
- **PASS** iff `attached_browser_pid == external_chrome_pid` AND
  `kuri_pids_after_go` did not grow AND
  `external_chrome_intercepted_requests > 0`.
- **FAIL** iff a new Kuri was launched, or the external Chrome's traffic
  was invisible to unbrowse.
- **AMBIGUOUS** iff Chrome on 9222 wasn't reachable (CDP handshake failed
  before unbrowse got a chance to attach — separate bug).

## Per-probe verdict shape

When you (the agent) finish judging, write a one-line verdict per probe
to `.harness-out/autonomous-discovery/<run-id>/verdict.md`:

```
probe-a: PASS  — in-flight buffer source served 4 ops in 2.1s (top op: search-mail)
probe-b: FAIL  — agent B got live-capture; flush-log shows no_durable_signal on all 6 captures
probe-c: PASS  — attached to pid 4421 (external Chrome), 11 requests captured
```

If any probe is `FAIL` or `AMBIGUOUS`, do not declare the North Star fix
shipped. Iterate.

## What this harness is NOT

- Not a unit test — never auto-asserts shape.
- Not a regex/grep judge — no `grep "PASS"`.
- Not in-process mocked — every probe runs the real CLI against the real
  local backend with real Kuri (or real attached Chrome).
- Not gated by exit code — exit codes only signal whether the harness
  itself crashed; the verdict is judged on the artifacts.

## Where outputs land

```
.harness-out/autonomous-discovery/
└── <run-id>/                      # ISO timestamp + 8 hex
    ├── manifest.json              # run metadata, git sha, version
    ├── probe-a.json               # collected fields (above)
    ├── probe-a.log                # full stdout/stderr from CLI calls
    ├── probe-a.resolve.json       # raw resolve response
    ├── probe-a.buffer.json        # buffer dump from /v1/admin/sessions/:id/buffer
    ├── probe-b.json
    ├── probe-b.log
    ├── probe-b.agent-a.flush-log
    ├── probe-b.marketplace.json
    ├── probe-c.json
    ├── probe-c.log
    ├── probe-c.session.json
    └── verdict.md                 # written by the agent after judging
```
