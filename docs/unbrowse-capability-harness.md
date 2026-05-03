# Unbrowse Capability Harness

Read when: judging whether this repo still supports drop-in onboarding, first-task public success, auth/browser handoff, and the explicit `cloudflare_blocked` boundary.

Run:

```bash
bun run eval:unbrowse-capability
```

What it judges:

- `install_setup`: blank-slate install/setup path exists and is scriptable
- `first_task_success`: public task corpus exists and has persisted all-pass evidence
- `auth_path`: `auth_required` + `sessions-scan` path stays explicit
- `browser_ops`: browse fallback verbs + handoff message still exist
- `hostile_site_boundary`: Cloudflare/browser gates stay encoded as blocked terminals
- `agent_guidance`: agent-XP visibility + judge loop entrypoints stay discoverable

Pass bar:

- `pass`: command surface + docs + onboarding hints are all present
- `partial`: core flow exists, but discoverability/help text still makes onboarding rough
- `fail`: a required onboarding, browser, or boundary surface is missing

Fib phases:

- `1`: plan from repo truth
- `2`: observe docs/runtime/tests/artifacts
- `3`: compress claims
- `4`: score integrity
- `5`: spawn bounded claim lanes
- `6`: collect claim lanes
- `7`: break to outer judgement
- `8`: `promote`, `repair`, `hold`, or `await_child_verdict`

Escalation:

- if structure is present but fresh empirical proof is missing, phase `7` requests a bounded deeper judge instead of self-promoting
- parent waits at `8` with `await_child_verdict`

Artifact:

- default output: `runs/fib-harness-report.json`
