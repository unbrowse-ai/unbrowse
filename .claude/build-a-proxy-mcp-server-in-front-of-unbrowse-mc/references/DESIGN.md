# Hot-reload MCP proxy — design

## Why

Closed-loop /unbrowse-mcp-gate fix runs need the agent to:
1. Run a gate wave (66 probes via mcp__unbrowse__* tools the agent calls in-thread).
2. Read verdict.json in-thread, identify a regression.
3. Edit src/ to fix it.
4. Re-run the gate.

Today step 4 breaks: Claude Code only spawns the unbrowse MCP child at
session start. Source edits do not reach the running child. The agent
must ask the user to `/mcp` reconnect, which loses the session, the
plan, and the in-flight task list.

Solution: a stdio proxy that Claude Code registers as the unbrowse MCP.
The proxy spawns `bun src/mcp.ts` as a child and relays JSON-RPC. On a
src/ file change, the proxy gracefully restarts the child. From Claude
Code's perspective the connection never drops.

## Transport

The unbrowse MCP uses line-delimited JSON-RPC over stdio (see
`src/mcp.ts:4` createInterface readline). Each line is one JSON-RPC
object. The proxy treats lines as opaque after parsing only what it
needs to make routing decisions.

## Components

### parent_io
stdin reader, stdout writer. Speaks to Claude Code. Buffers complete
lines. On line in: parse, decide route, forward to child or handle
locally (e.g. ping, initialize-replay state).

### child_proc
ChildProcess from `node:child_process` (`Bun.spawn` if running on bun).
stdin/stdout piped. Stderr forwarded to proxy stderr so user sees
unbrowse logs.

### relay
On child stdout line: parse minimally (just to extract id for in-flight
tracking), write to parent_io.stdout. On parent line: forward to
child_proc.stdin. The whole thing is opaque-line-shoveling with two
state-machine hooks (see below).

### watcher
chokidar.watch on `src/**.ts` and key gate-affecting paths
(`harness/probes/*.txt`, `harness/probes/GATE_JUDGE.md`).
On change: emit `restart_requested` event. Debounce 300ms to batch
rapid saves.

### lifecycle
Owns the child restart. On `restart_requested`:
1. Pause forwarding from parent. Queue incoming parent lines.
2. SIGTERM child. Wait up to 2000ms for exit. SIGKILL if still alive.
3. Cancel in-flight requests: for each id in `inflight_to_child`, emit
   `{jsonrpc:"2.0", id, error:{code:-32099, message:"proxy hot-reload"}}`
   to parent. Claude Code retries on transient errors.
4. Spawn new child with same argv.
5. Replay cached `initialize` request to new child. Wait for response.
   Discard the response (parent already got its initialize back).
6. Replay any tool-list state if needed (Claude may have already cached
   tool descriptions — server-changed notifications are MCP-standard but
   this proxy does NOT inject them; the cache is good enough for one
   probe round-trip and the next gate-wave reads fresh).
7. Drain queued parent lines to new child stdin.
8. Resume normal relay.

## Initialize replay

The MCP `initialize` request defines client capabilities (protocol
version, sampling capability, etc.). The proxy caches the FIRST
`initialize` request it sees from the parent (raw bytes). After every
child respawn, the proxy sends that same JSON line to the child on its
stdin BEFORE forwarding queued requests. The child's `initialize`
response is consumed by the proxy (do not forward to parent — parent
got its initialize way back).

If the child fails to reach `initialize` reply within 5000ms, the proxy
emits a SystemMessage notification to the parent ("child failed to
re-initialize") and continues to queue. Manual intervention required.

## In-flight cancellation

Each request from parent with an id is tracked in `inflight_to_child:
Map<id, {parent_id, sent_at}>`. When the response comes back from
child, the entry is removed.

On respawn, all entries are cancelled with -32099. Claude Code's MCP
client treats this as a transient error and may retry. For the gate
loop, the agent re-issues the failing tool call in-thread; the new
child handles it correctly.

This is intentionally simple: an alternative is to replay the same
request to the new child and map the new response id back to the old
parent id. That requires per-request id rewriting on both legs and
is OUT OF SCOPE for the MVP.

## File watching scope

Files that warrant a restart:
- src/**/*.ts (the MCP body + execution + capture + every imported module)
- harness/probes/corpus-gate.txt (gate corpus)
- harness/probes/GATE_JUDGE.md (verdict rubric)
- harness/probes/bench-gate-baseline.json (thresholds)

Files explicitly excluded:
- node_modules/
- .bench-gate/, .bench-local/
- *.test.ts (test files do not affect runtime; the gate loop doesn't
  read them through the MCP)
- packages/, frontend/, backend/ (own MCP server is not these)

## Process supervision

If the child exits unexpectedly (non-SIGTERM, non-zero exit), the proxy
treats it as a crash and respawns automatically with the same
initialize-replay path. After 3 crashes in 10 seconds the proxy stops
trying and emits an error notification to parent. The user must then
fix the source and the proxy will recover on next file change.

## Failure-mode contract

- Proxy startup with no child binary: parent gets initialize response
  built BY the proxy that lists zero tools; subsequent tool calls error
  with "unbrowse MCP child failed to start: <reason>".
- File-change while a tool call is in-flight: that call is cancelled
  with -32099; subsequent calls are queued and forwarded after respawn.
- Two file changes 100ms apart: debounce collapses them to one restart.

## What this is NOT

- A replacement for the unbrowse MCP. It is a transparent stdio
  passthrough that only intervenes on respawn.
- A patch system. It does not modify the child's behavior, code, or
  responses. It only relays bytes.
- A gate runner. The gate is /unbrowse-mcp-gate, separate skill. This
  proxy only enables the gate loop to run multiple iterations without
  losing the Claude Code connection.
- An MCP server in its own right. It has no tools, no resources, no
  capabilities of its own. Every parent JSON-RPC line is forwarded.

## Verify gate (what `verify.sh` proves)

A persistent stdio harness:
1. Spawns the proxy.
2. Sends initialize + tools/list. Records the description-text of one
   stable tool (e.g. `unbrowse_health`).
3. Edits src/mcp.ts to inject a sentinel token like
   `PROXY-RELOAD-OK-<unix-ts>` into that tool's description.
4. Waits up to 5000ms (debounce + restart + initialize).
5. Sends tools/list again on the SAME stdio connection. Asserts the
   sentinel is now in the description.
6. Reverts the sentinel edit.
7. Exits 0 if sentinel was seen, exit 1 otherwise.

The harness deliberately does NOT restart its own stdio process. The
parent connection survival is the property under test.

## Out-of-scope future work

- HTTP-streaming MCP transport (when Claude Code adopts it).
- Request-id-rewriting for true in-flight survival across restart.
- Sentry-style automatic crash reporting from the child.
- Multi-child support (parallel collectors via one proxy).
