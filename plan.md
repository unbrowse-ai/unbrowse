# Plan — maximize the four-axis capability benchmark (staging + npm binary)

> Drive the **npm-installed `unbrowse` binary** (`UNBROWSE_BIN=/opt/nanobrew/prefix/bin/unbrowse`,
> via `npm i -g .`) against the **staging backend** (`UNBROWSE_API_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev`)
> to pass all four capability axes on FRESH evidence. Witness: `bench/capability/gate_current.sh`
> (latest-row-per-axis, current-binary — not gate_all's ever-passed). Completion is judgment
> (`--promise`): all four green fresh AND levers genuinely exhausted. No fabricated green; honest
> negatives kept; the skill's dated report is written each iteration.

## Baseline (2026-06-13T120000Z, staging + npm binary)

| axis | state | why |
|---|---|---|
| A action-retrieval coverage | **PASS** (cov 0.78) but H/A tiers weak (0.67 vs Reddit 1.0) | misses are SPA/anti-bot XHR endpoints not surfaced by capture |
| B execution two-witness | **FAIL** — `live-nocapture` | no content-bound two-witness capture produced |
| C execution with auth | **FAIL** — `authed=False` | 5 cookies injected but session not logged-in |
| D security leak-scan | **PASS** — 0 leaks / 388 sessions | clean |

## Loop (each iteration: bench → analyse → real code change → re-bench → record validated delta)

1. **Axis B — execution two-witness.** Investigate why the live driver reports `live-nocapture`
   (the binary's capture path against the test origin produced no two-witness content-bound green).
   Likely a capture/anti-bot or staging-routing issue. Fix in unbrowse; re-bench Axis B.
2. **Axis C — auth.** cookies inject but `logged_in=False`. Investigate the cookie→session path
   (the test reads an auth-only endpoint); fix the auth flow so an authenticated read returns
   auth-only data. Re-bench Axis C.
3. **Axis A — tier coverage.** Lift H (hardest-scrape) + A (automation) tier coverage above 0.67
   by surfacing the missed SPA/anti-bot XHR endpoints (extraction/capture improvement). Re-bench.
4. **Hold D.** Keep the leak-scan clean (no regression).

## Witness + honesty
- `bench/capability/gate_current.sh` exits 0 only when the LATEST A/B/C/D rows all pass — the
  current binary, not stale evidence. RED now (B, C).
- `--promise` is self-asserted (weak): the loop stays locked until I judge all-four-fresh-green
  AND no lever moves the real number. Every iteration writes a dated report
  (`bench/capability/reports/`) and appends honest history; single-run deltas (n<30) are noise,
  not improvements (the skill's n≥30 rule).

## Diagnosis (day 1-2 walk) — B + C are ONE bug

Both browser-capture axes (B two-witness, C auth) died on `ERR_PROXY_CONNECTION_FAILED`:
every `unbrowse go` returned the `chrome-error://` "No Internet … proxy server" page, so B had
no content and C couldn't establish a session. Axis A passed because `explain`'s capture path
does not route through the browser proxy.

Root cause (verified): `src/env/kuri-proxy-bridge.ts` — `UNBROWSE_KURI_PROXY` unset is treated
as **"auto"** → `resolveEgressProxy` → the **iproyal creds at `~/.identity/iproyal-creds`** →
Kuri's Chrome is launched with `--proxy-server=<local forwarder → iproyal>`. The iproyal
upstream is unreachable, so the forwarder dead-ends and **every browser capture fails, with no
fallback to direct**. `UNBROWSE_KURI_PROXY=0` alone didn't help while a stale proxied Chrome
was running (the binary re-attached to it).

Fix (verified manually): kill the stale `kuri-proxy-forwarder` + Chrome, run direct
(`UNBROWSE_KURI_PROXY=0`) → `go` returns real Reddit JSON. The bench is re-running with this.

**Durable code lever (the real improvement):** the browser-capture path should detect a dead
proxy (`ERR_PROXY_CONNECTION_FAILED` / a `chrome-error://` result) and **retry direct** rather
than brick — so the default binary survives a dead residential-proxy upstream. That is the next
node after the bench confirms the env fix unblocks B/C.

## WALK status — witness GREEN (gate_current exit 0); maximization levers remain

- [x] baseline run (staging + npm binary) → report 2026-06-13T120000Z.md; gate_current RED (B,C)
- [x] diagnose B+C → dead iproyal proxy on the browser-capture path (verified root cause)
- [x] **Axis B execution → fresh GREEN** (ts 140000Z): 2 distinct captures, 23762 B each, score 1.0, key=rust, `source=live`
- [x] **Axis C auth → fresh GREEN** (ts 140000Z): `session_stateful=True, authed=True`
- [x] **gate_current.sh exits 0** — all four axes green on the current binary
- [ ] **durable code fix (NOT done):** capture path detects a dead proxy (`ERR_PROXY_CONNECTION_FAILED` /
      `chrome-error://`) and retries DIRECT, so the default binary survives a dead residential-proxy
      upstream instead of bricking. This is the real shipped-binary delta — the witness green above
      came from an ENV override (`UNBROWSE_KURI_PROXY=0`), not a code change.
- [ ] **Axis A H/A tiers (NOT done):** lift hardest-scrape + automation coverage above 0.67.
- [ ] full maximization / promise: NOT emitted — levers above are real and unexhausted.

Honest note: the witness measures the binary's *capability* (B/C are green — the binary captures +
auths correctly when egress works), masked earlier by a dead LOCAL proxy. That capability is real;
the robustness gap (dead-proxy → brick) is the next code lever, recorded, not faked.

(Prior plans — pay.sh, prod-hardening, EmergentDB — in git history.)
