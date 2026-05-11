# Disposable mcp-serve: test plan

Validation plan for the idle reaper + sessions.jsonl rehydration work on branch `feat/stateless-mcp-reaper`. The goal is to confirm two user-visible outcomes:

1. **Zombies stop accumulating.** After a Claude session ends, the `unbrowse serve` daemon self-exits within ~60s instead of detaching forever.
2. **Active browse sessions survive daemon restarts.** If the reaper kills the daemon (or it crashes) while a session is open, the next `unbrowse mcp` call picks up the session by ID and doesn't have to re-browse from scratch.

Heuristic verdicts are out — the harness collects evidence, the agent judges in-thread. See `feedback_harness_makes_visible_agent_judges.md` for the principle.

---

## Layer 1 — unit tests (already passing)

Cheapest. Run on every change to this branch.

```bash
bun test tests/server-reaper.test.ts tests/session-store.test.ts tests/session-rehydrate.test.ts
```

Expected: **16 pass, 0 fail**.

What they prove:
- Reaper exits when idle, stays alive while pinged, respects `UNBROWSE_SERVE_IDLE_MS=0`
- session-store roundtrips create / drop / update, survives malformed lines, compacts correctly
- Rehydration on cold start restores sessions from disk, drops sessions that were dropped before shutdown, idempotent, handles fresh-install case

What they do NOT prove:
- That the real CLI flow (`unbrowse mcp` → `unbrowse serve` child) actually triggers the reaper
- That a real browse session (with Kuri + Chrome) survives a real respawn
- That the cookie-injection / HAR / orchestrator paths aren't broken by rehydrated sessions whose `client` field is undefined

---

## Layer 2 — daemon lifecycle smoke test (manual)

Validates the OS-level process behavior: spawn the daemon, watch it self-exit, confirm the pid-file is cleaned up. No browser involved.

### Setup

```bash
pkill -9 -f 'unbrowse|kuri' 2>/dev/null; sleep 1
rm -f ~/.unbrowse/serve.pid ~/.unbrowse/sessions.jsonl
mkdir -p /tmp/unbrowse-layer2
rm -f /tmp/unbrowse-layer2/*
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
```

### Run

```bash
# Short idle window so the test doesn't take 60s.
UNBROWSE_SERVE_IDLE_MS=3000 \
UNBROWSE_SERVE_IDLE_CHECK_MS=500 \
UNBROWSE_PID_FILE=/tmp/unbrowse-layer2/server.pid \
bun src/server.ts 127.0.0.1 6970 > /tmp/unbrowse-layer2/daemon.log 2>&1 &
SERVER_PID=$!

# Capture a /health response to confirm the daemon came up.
sleep 1
curl -s http://127.0.0.1:6970/health > /tmp/unbrowse-layer2/health.json
echo "health_exit=$?" > /tmp/unbrowse-layer2/health.exit

# Wait past idleMs + a few check intervals (3s idle + buffer = 5s).
sleep 5

# Capture the post-idle process state — `ps -p` returns 0 if alive, 1 if dead.
# We record both the exit code AND the raw output, so the agent sees both.
ps -p $SERVER_PID > /tmp/unbrowse-layer2/server.ps 2>&1
echo "ps_exit=$?" > /tmp/unbrowse-layer2/server.ps.exit

# Capture pid-file presence — `ls -la` returns the row if present, an error if not.
ls -la /tmp/unbrowse-layer2/server.pid > /tmp/unbrowse-layer2/pidfile.ls 2>&1
echo "ls_exit=$?" > /tmp/unbrowse-layer2/pidfile.ls.exit
```

### Evidence to collect

The artifact files the agent will read, in order:

```bash
echo "--- daemon log (tail) ---"
tail -n 40 /tmp/unbrowse-layer2/daemon.log
echo "--- /health response ---"
cat /tmp/unbrowse-layer2/health.json; echo
cat /tmp/unbrowse-layer2/health.exit
echo "--- post-idle ps -p \$SERVER_PID ---"
cat /tmp/unbrowse-layer2/server.ps
cat /tmp/unbrowse-layer2/server.ps.exit
echo "--- post-idle pid-file ls ---"
cat /tmp/unbrowse-layer2/pidfile.ls
cat /tmp/unbrowse-layer2/pidfile.ls.exit
echo "--- all unbrowse/kuri processes remaining ---"
ps aux | grep -E 'unbrowse|kuri|node.*server\.ts' | grep -v grep
```

Each block prints raw output. No comparisons, no labels-as-verdicts.

### Agent judgment

An agent reading the assembled evidence above is looking for these criteria. They are the judge, not the script:

- **Daemon came up:** `health.json` should contain a JSON body with `"status":"ok"`. `health.exit=0` confirms curl reached the server.
- **Reaper fired:** `daemon.log` tail should contain a line like `[reaper] idle, exiting`. Its absence means the timer never tripped (suspect `setInterval` not running, `idleMs` parse failure, or `unref` killing the timer prematurely).
- **Process exited:** `server.ps` should show no row for `$SERVER_PID`, and `ps_exit=1` confirms `ps -p` failed to find it. If `ps_exit=0` and the row is present, the process is still alive past the idle window — reaper code present but ineffective.
- **Pid file cleaned:** `pidfile.ls` should show an `ls: cannot access` style error and `ls_exit` should be nonzero. If the file is still listed, `clearPidFile` was not called on the reaper's exit path.
- **No stragglers:** the final `ps aux | grep -E 'unbrowse|kuri'` block should show zero matching processes (or only Kuri/Chrome if those were intentionally left running). If a Node `unbrowse` row remains, the reaper didn't fully terminate the process tree.

---

## Layer 3 — packaged-binary lifecycle (the real path)

The reaper has to work through the bundled binary, not just `bun src/server.ts`. This catches packaging regressions.

### Setup

```bash
pkill -9 -f 'unbrowse|kuri' 2>/dev/null; sleep 1
mkdir -p /tmp/unbrowse-layer3
rm -f /tmp/unbrowse-layer3/*
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/packages/skill
npm pack > /tmp/unbrowse-layer3/pack.log 2>&1
# Locate the resulting tarball.
TARBALL=$(ls -t unbrowse-*.tgz | head -1)
echo "$PWD/$TARBALL" > /tmp/unbrowse-layer3/tarball.path

mkdir -p /tmp/unbrowse-test && cd /tmp/unbrowse-test
rm -rf node_modules
npm i "$(cat /tmp/unbrowse-layer3/tarball.path)" > /tmp/unbrowse-layer3/install.log 2>&1
```

### Run

```bash
cd /tmp/unbrowse-test

# Spawn an MCP client (just enough to bring the daemon up).
UNBROWSE_SERVE_IDLE_MS=5000 \
UNBROWSE_SERVE_IDLE_CHECK_MS=500 \
./node_modules/.bin/unbrowse health > /tmp/unbrowse-layer3/health.out 2>&1
echo "health_exit=$?" > /tmp/unbrowse-layer3/health.exit
sleep 1

# Snapshot processes immediately after the call. Print full rows (no count threshold).
ps aux | grep -E 'unbrowse|kuri|node.*server' | grep -v grep > /tmp/unbrowse-layer3/ps.before 2>&1
echo "ps_before_exit=$?" > /tmp/unbrowse-layer3/ps.before.exit

# Wait past the idle window + buffer.
sleep 8

# Snapshot again after idle.
ps aux | grep -E 'unbrowse|kuri|node.*server' | grep -v grep > /tmp/unbrowse-layer3/ps.after 2>&1
echo "ps_after_exit=$?" > /tmp/unbrowse-layer3/ps.after.exit
```

### Evidence to collect

```bash
echo "--- npm pack log (tail) ---"
tail -n 5 /tmp/unbrowse-layer3/pack.log
echo "--- npm install log (tail) ---"
tail -n 10 /tmp/unbrowse-layer3/install.log
echo "--- /health response from packaged binary ---"
cat /tmp/unbrowse-layer3/health.out
cat /tmp/unbrowse-layer3/health.exit
echo "--- processes immediately after health call ---"
cat /tmp/unbrowse-layer3/ps.before
cat /tmp/unbrowse-layer3/ps.before.exit
echo "--- processes after idle window ---"
cat /tmp/unbrowse-layer3/ps.after
cat /tmp/unbrowse-layer3/ps.after.exit
```

Each block prints raw rows or raw exit codes. No comparisons or thresholds.

### Agent judgment

An agent reading the evidence above applies these criteria:

- **Pack + install succeeded:** `health.exit=0` and `/health` returned a JSON body containing `"status":"ok"`. If install failed, `install.log`'s tail will show npm errors and `health.exit` will be nonzero; that's a packaging regression unrelated to the reaper, abort the rest.
- **Daemon came up after the install:** `ps.before` should contain at least one row matching `unbrowse|node.*server` and one matching `kuri`. Zero matches there means the packaged CLI didn't manage to spawn its daemon — bundling regression.
- **Reaper drained the Node processes:** `ps.after` should contain zero rows matching `unbrowse|node.*server`. If any Node row remains, the reaper either didn't fire (check the daemon's stdout for `[reaper] idle, exiting`) or fired but failed to terminate the process (check `installServerExitCleanup`).
- **Kuri intentionally left alive:** `ps.after` may still contain a `kuri` row — that is expected. Kuri is the long-lived Zig broker; the reaper does not touch it (warm CDP at 3ms is the win). If Kuri also vanished, something is calling `shutdownAllBrowsers` from the reaper exit path, which is a bug.
- **Both daemons gone (the "two-process" question):** if the `unbrowse mcp` parent and the `unbrowse serve` child both spawn, `ps.after` should be free of both. If `mcp-serve` exits but `unbrowse serve` lingers, the reaper is missing a code path; if `unbrowse serve` exits but `mcp-serve` lingers, the parent didn't propagate the child's exit.
---

## Layer 4 — session-survives-restart (the headline claim)

The hardest test. Validates that an open browse session persists when the daemon is killed mid-session.

### Setup

```bash
pkill -9 -f 'unbrowse|kuri' 2>/dev/null; sleep 1
rm -f ~/.unbrowse/sessions.jsonl
mkdir -p /tmp/unbrowse-layer4
rm -f /tmp/unbrowse-layer4/*
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
```

### Run

```bash
# Step 1: open a browse session via the daemon.
UNBROWSE_SERVE_IDLE_MS=0 bun src/cli.ts browse go --url https://example.com --json \
  > /tmp/unbrowse-layer4/session1.json 2>/tmp/unbrowse-layer4/session1.err
SESSION_ID=$(jq -r .session_id /tmp/unbrowse-layer4/session1.json 2>/dev/null || echo "")
echo "session_id=$SESSION_ID" > /tmp/unbrowse-layer4/session_id.txt

# Step 2: capture the persisted state right after open.
cp ~/.unbrowse/sessions.jsonl /tmp/unbrowse-layer4/sessions.after-open 2>/dev/null \
  || echo "(no sessions.jsonl)" > /tmp/unbrowse-layer4/sessions.after-open

# Step 3: kill the daemon. Kuri stays up; Chrome tab stays open.
DAEMON_PID=$(cat ~/.unbrowse/serve.pid 2>/dev/null | jq -r .pid 2>/dev/null || echo "")
echo "daemon_pid=$DAEMON_PID" > /tmp/unbrowse-layer4/daemon_pid.txt
if [ -n "$DAEMON_PID" ]; then kill "$DAEMON_PID" 2>/dev/null; fi
sleep 2
ps -p "$DAEMON_PID" > /tmp/unbrowse-layer4/daemon.ps 2>&1
echo "daemon_ps_exit=$?" > /tmp/unbrowse-layer4/daemon.ps.exit

# Step 4: snap the same session via a NEW daemon (auto-spawned).
bun src/cli.ts browse snap --session-id "$SESSION_ID" --json \
  > /tmp/unbrowse-layer4/session2.json 2>/tmp/unbrowse-layer4/session2.err
echo "snap_exit=$?" > /tmp/unbrowse-layer4/snap.exit

# Step 5: capture the new daemon's pid + log.
cp ~/.unbrowse/serve.pid /tmp/unbrowse-layer4/serve.pid.after 2>/dev/null \
  || echo "(no new serve.pid)" > /tmp/unbrowse-layer4/serve.pid.after
```

### Evidence to collect

```bash
echo "--- session 1 open response ---"
jq . /tmp/unbrowse-layer4/session1.json 2>/dev/null || cat /tmp/unbrowse-layer4/session1.json
echo "--- session 1 stderr ---"
cat /tmp/unbrowse-layer4/session1.err
echo "--- captured session_id ---"
cat /tmp/unbrowse-layer4/session_id.txt
echo "--- sessions.jsonl after open ---"
cat /tmp/unbrowse-layer4/sessions.after-open
echo "--- daemon pid we tried to kill ---"
cat /tmp/unbrowse-layer4/daemon_pid.txt
echo "--- ps -p \$DAEMON_PID after kill ---"
cat /tmp/unbrowse-layer4/daemon.ps
cat /tmp/unbrowse-layer4/daemon.ps.exit
echo "--- snap response on new daemon ---"
jq '{ok: .ok, session_id: .session_id, has_tree: (.tree != null), tree_preview: (.tree // "" | tostring | .[0:200])}' \
  /tmp/unbrowse-layer4/session2.json 2>/dev/null || cat /tmp/unbrowse-layer4/session2.json
cat /tmp/unbrowse-layer4/snap.exit
echo "--- snap stderr ---"
cat /tmp/unbrowse-layer4/session2.err
echo "--- new daemon pid file ---"
cat /tmp/unbrowse-layer4/serve.pid.after
```

### Agent judgment

An agent reading the evidence above applies these criteria:

- **Session opened cleanly:** `session1.json` should contain a `session_id` field; `session_id.txt` should hold that value (non-empty). `session1.err` should be free of stack traces.
- **Persistence wrote to disk:** `sessions.after-open` should be a JSONL file with at least one `{"op":"create",…}` line whose `sessionId` matches `session_id.txt`. If it says `(no sessions.jsonl)`, the persistence hook in `createRegisteredBrowseSession` didn't fire.
- **Old daemon really died:** `daemon.ps` should not list the pid, and `daemon_ps_exit` should be `1`. If the row is present and exit is `0`, the daemon survived `kill` (rare; might be a wrapper script eating the signal).
- **Rehydration happened on the new daemon:** the new daemon's log (visible in subsequent `unbrowse` invocations' stderr or in the pid file's parent process tree) should contain a line `[session-store] rehydrated browse sessions from disk` with `restored: 1`. Absence means the new daemon didn't read `sessions.jsonl` at startup.
- **Snap succeeded against the rehydrated session:** the `jq` output should show `ok: true`, the same `session_id`, and `has_tree: true`. If `ok: false` with `session_not_found`, rehydration didn't populate the in-memory Map. If `ok: true` but `has_tree: false`, the Chrome tab was killed by `shutdownAllBrowsers` on daemon shutdown — close handler is too aggressive, investigate `installServerExitCleanup`.
- **New daemon really is new:** `serve.pid.after` should hold a different `pid` than `daemon_pid.txt`. Same pid means the kill failed and we're not actually exercising the restart path.

## Layer 5 — eatigo reproduction (the original bug)

This is what triggered the work. Lewis ran the unbrowse command across 5+ Claude session restarts and accumulated 20+ zombie processes. Re-run the same flow and verify the zoo doesn't reappear.

### Setup

```bash
pkill -9 -f 'unbrowse|kuri' 2>/dev/null; sleep 1
mkdir -p /tmp/unbrowse-layer5
rm -f /tmp/unbrowse-layer5/*
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
```

### Run

```bash
# Simulate 5 Claude sessions starting up, doing one MCP call each, and ending.
# Override the idle window so the test doesn't take a full minute.
for i in 1 2 3 4 5; do
  UNBROWSE_SERVE_IDLE_MS=5000 bun src/cli.ts health > /dev/null 2>&1
  sleep 1
done

# Snapshot processes immediately after the burst. Print full rows (no count).
ps aux | grep -E 'unbrowse|kuri|node.*server' | grep -v grep > /tmp/unbrowse-layer5/ps.burst 2>&1
echo "ps_burst_exit=$?" > /tmp/unbrowse-layer5/ps.burst.exit

# Wait past the idle window + buffer.
sleep 8

# Snapshot again after idle.
ps aux | grep -E 'unbrowse|kuri|node.*server' | grep -v grep > /tmp/unbrowse-layer5/ps.idle 2>&1
echo "ps_idle_exit=$?" > /tmp/unbrowse-layer5/ps.idle.exit
```

### Evidence to collect

```bash
echo "--- processes immediately after 5 invocations ---"
cat /tmp/unbrowse-layer5/ps.burst
cat /tmp/unbrowse-layer5/ps.burst.exit
echo "--- processes after idle window ---"
cat /tmp/unbrowse-layer5/ps.idle
cat /tmp/unbrowse-layer5/ps.idle.exit
```

Each block prints the raw rows. The agent counts and classifies; the script does not.

### Agent judgment

An agent reading the evidence above applies these criteria:

- **Singleton behavior:** `ps.burst` should contain **one** row per category (one `unbrowse mcp` parent, one `mcp-serve` child, one `unbrowse serve` daemon, one `kuri`). Five rows per category means the pid-file singleton in `runtime/local-server.ts:ensureLocalServer` is broken — each invocation spawned its own daemon. That is the original bug; if it reappears, neither the singleton nor the reaper is helping.
- **Reaper drained Node processes:** `ps.idle` should be **empty** of `unbrowse` and `node.*server` rows. Any Node row that survives the idle window means the reaper did not fire or did not exit cleanly.
- **Kuri intentionally remains:** `ps.idle` may show a `kuri` row. That's expected — the reaper does not touch Kuri. If it's missing, something is forcing Kuri shutdown from the reaper path.
- **Anti-pattern signal — many daemons at once:** if `ps.burst` shows multiple `unbrowse serve` rows running simultaneously (different PIDs, same command), the singleton failed and the test plan should also reproduce on `runtime/local-server.ts:ensureLocalServer`'s pid-file race, not just on the reaper.

## Layer 6 — does it break anything? (regression check)

Run the existing test suites that exercise the orchestrator + capture pipeline. These are the ones most likely to break if rehydration restores a session whose `client` field is `undefined`.

### Setup

```bash
mkdir -p /tmp/unbrowse-layer6
rm -f /tmp/unbrowse-layer6/*
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse

# Capture the baseline error count for context (CLAUDE.md notes ~191 pre-existing tsc errors).
bun --bun tsc --noEmit 2>&1 > /tmp/unbrowse-layer6/tsc.head.out || true
```

### Run

```bash
cd /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse

# Backend security/auth surface (fast).
bun test ./backend/tests/{skills-trust-promotion,skills-publish-proofs,proof-verifier,x402-skill-route,auth-routes-magic-flow,auth-failure-modes,protected-routes-auth}.test.ts \
  > /tmp/unbrowse-layer6/backend.out 2>&1
echo "backend_exit=$?" > /tmp/unbrowse-layer6/backend.exit

# Browse-session + capture (the ones most likely to regress).
bun test tests/browse-*.test.ts tests/extraction-*.test.ts \
  > /tmp/unbrowse-layer6/browse.out 2>&1
echo "browse_exit=$?" > /tmp/unbrowse-layer6/browse.exit

# Server health (touches startUnbrowseServer end-to-end).
bun test tests/server-health.test.ts tests/server-supervisor.test.ts \
  > /tmp/unbrowse-layer6/server.out 2>&1
echo "server_exit=$?" > /tmp/unbrowse-layer6/server.exit

# New unit tests for this branch — should be solid green.
bun test tests/server-reaper.test.ts tests/session-store.test.ts tests/session-rehydrate.test.ts \
  > /tmp/unbrowse-layer6/new.out 2>&1
echo "new_exit=$?" > /tmp/unbrowse-layer6/new.exit
```

### Evidence to collect

```bash
echo "--- backend security/auth tail ---"
tail -n 20 /tmp/unbrowse-layer6/backend.out
cat /tmp/unbrowse-layer6/backend.exit
echo "--- browse-session + extraction tail ---"
tail -n 20 /tmp/unbrowse-layer6/browse.out
cat /tmp/unbrowse-layer6/browse.exit
echo "--- server-health + supervisor tail ---"
tail -n 20 /tmp/unbrowse-layer6/server.out
cat /tmp/unbrowse-layer6/server.exit
echo "--- new unit tests (reaper + session-store + rehydrate) tail ---"
tail -n 20 /tmp/unbrowse-layer6/new.out
cat /tmp/unbrowse-layer6/new.exit
echo "--- failing test names across all four runs ---"
grep -hE '\(fail\)' /tmp/unbrowse-layer6/{backend,browse,server,new}.out || true
```

### Agent judgment

An agent reading the evidence above applies these criteria:

- **New unit tests must be green:** `new.exit=0` and the tail shows `16 pass, 0 fail`. Any failure here means the branch's own claims are wrong; stop and fix before judging the others.
- **Backend security/auth must be green:** `backend.exit=0`. These touch `recordAnalyticsSession`, `unkey` lookups, x402 flows — none should be affected by the reaper or sessions.jsonl. Any failure is a regression from this branch.
- **Browse + extraction may have pre-existing noise:** compare failing test names from this run against the same suites on `main` (`git stash && bun test ... && git stash pop`). New failures involving `browseSessions`, `BrowseSession.client`, or rehydration → directly caused by this branch. New failures involving extraction or capture pipeline → indirect, look at orchestrator state shape.
- **Server health touches the reaper directly:** `server.exit=0` is mandatory. The reaper adds an `onRequest` hook + `setInterval`; if either breaks Fastify's startup or shutdown, this is where it shows.
- **tsc baseline check:** `tsc.head.out` should contain ~191 errors (the documented baseline). A significantly higher number means a typing regression. CLAUDE.md notes the root tsc has long-standing baseline noise; the test plan's claim is "zero NEW errors", not "zero errors."
## Layer 7 — canonical post-release check (the user-visible truth)

The canonical post-release smoke run lives in the internal `scripts/` directory and is enumerated in `CLAUDE.md > "Post-release agent experience review"` as MANDATORY after every release. Re-run on a remote host to validate that the dogfooding loop still works end-to-end with the new daemon lifecycle. The path and remote target are documented in `CLAUDE.md`; do not name them in this doc.

### Evidence to collect

The JSON artifact contains per-task results. The agent reviews each row against the rubric in `CLAUDE.md > "Post-release agent experience review"`:

| Task | Pass if |
|------|---------|
| health | `status: "ok"`, version matches |
| resolve | `available_operations` has 1+ endpoints |
| execute | `success: true`, response has domain-relevant data |
| search | param-filled, returns results |
| feedback | `ok: true` |
| browse_go | `ok: true`, `session_id` present |
| browse_eval | result contains page content |
| browse_snap | a11y tree with `[e0]` root |
| browse_close | `ok: true` |

### Agent judgment

- All tasks pass → ship
- browse_go succeeds but browse_snap fails with `session_not_found` → rehydration didn't trigger on remote daemon (timing issue, or sessions.jsonl path mismatch)
- All browse_* fail → daemon lifecycle is broken; daemon is being reaped while a session is still active (UNBROWSE_SERVE_IDLE_MS too aggressive, or session count not being read correctly by the reaper)

---

## Known unknowns to watch for

1. **`brokerForSession` with undefined client.** Rehydration restores sessions without their `client` BrowseSessionClient field. The existing `brokerForSession` in `src/api/routes.ts:309` falls back to `kuri.getKuriClient(brokerPort)` when `session.client` is undefined — so rehydrated sessions should work. But if any code path assumes `session.client` is truthy, rehydrated sessions will throw.

2. **Tab id drift.** Chrome assigns tab ids; if Chrome restarts (not just Kuri — Chrome itself), the tab ids change. Rehydration would point at stale tab ids. `isBrowseSessionLive` should catch this on first use and `removeBrowseSession` would emit a drop event. Worth validating with: kill Chrome, restart, try to use a rehydrated session — should fail gracefully, not crash.

3. **Race on concurrent writes.** Two daemons starting up at once (e.g. two MCP clients spawning before pid-file lock takes effect) would both write to `sessions.jsonl`. POSIX `appendFileSync` is atomic for lines < 4KB so corruption is unlikely, but ordering between the two writers is non-deterministic. Should not break anything because each writer's events refer to disjoint sessionIds, but worth a stress test if production load grows.

4. **Stale sessions accumulating over weeks.** If a user opens many sessions and never closes them (e.g. crashes mid-flow), the file grows. Compaction at 256 lines mitigates this, but the on-disk record count of "active" sessions can grow unboundedly. Consider a TTL — drop persisted sessions older than 24h on rehydrate.

---

## Falsifier — what the agent should refuse to ship

This is the doc's last word, and it is addressed to the agent who has just finished reading the assembled evidence from Layers 1–7. The script does not emit a verdict; you do. Refuse to call the branch ready if any of the following are visible in the evidence:

1. **Daemon survived the idle window.** Layer 2's `server.ps` lists `$SERVER_PID` as alive, or Layer 3's `ps.after` still shows `unbrowse|node.*server` rows, or Layer 5's `ps.idle` shows the same. The reaper's job is to exit; any survival is a failure of the headline claim.

2. **An open session did not survive a daemon restart.** Layer 4's snap response shows `ok: false` or `session_not_found` against the same `session_id` that opened cleanly in Step 1. The persistence-and-rehydration claim is what the whole `sessions.jsonl` work exists to prove.

3. **Persistence skipped the write.** Layer 4's `sessions.after-open` reads `(no sessions.jsonl)` or contains zero `"op":"create"` lines for the opened session. Persistence ran but didn't reach disk; the rehydrate path has nothing to read.

4. **Browse, capture, or server-health regressions appeared.** Layer 6's `browse.exit` or `server.exit` is nonzero with failing test names that do not appear when the same suites run against `main`. The orchestrator is corrupting state because of `client === undefined` on a rehydrated session, or the reaper's onRequest hook broke Fastify startup. Either narrow the rehydrate (don't touch `harActive`, drop sessions older than X), or ship Phase 1 reaper-only behind a flag and revisit rehydration in a follow-up.

5. **Kuri got reaped.** Any layer's post-idle process snapshot shows zero `kuri` rows. Kuri is intentionally not touched by the reaper; if it dies, `shutdownAllBrowsers` is being called from the reaper exit path, which is incorrect.

If none of the above hold across the assembled artifacts, the branch passes this plan's bar — and Layer 7 (the canonical agent-experience harness) is the final remote check before tagging a release per `CLAUDE.md > "Post-release agent experience review"`.
