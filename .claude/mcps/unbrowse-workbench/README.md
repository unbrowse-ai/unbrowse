# unbrowse-workbench (Day-3 seed)

A proxy MCP that fans every `tools/call` to TWO upstream unbrowse MCPs (candidate + baseline) in parallel, merges a `_workbench_delta` field into the live response, and lets Day-4 swap which side is live via SIGHUP.

## What it is

- A bun-runnable JSON-RPC line-delimited proxy at `bin/proxy.ts`.
- Spawns CANDIDATE (default: source-tree `bun run src/mcp.ts`) and BASELINE (a prior released `unbrowse` binary) as child processes.
- For `tools/call`: forwards verbatim to both, awaits both, returns the live side with a `_workbench_delta` envelope.
- For non-call requests (initialize, tools/list, ping): forwards to the live side only.

## Install into Claude Code

Copy the `mcpServers` block from `mcp.json` into `~/.claude.json` (global) or your project's `.mcp.json`. After editing, restart Claude Code.

## Env vars

- `UNBROWSE_BIN_CANDIDATE`: shell-style command for the candidate. Default: `bun run /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/src/mcp.ts`.
- `UNBROWSE_BIN_BASELINE`: shell-style command for the baseline. Recommended: an absolute path to a previously released `unbrowse mcp` binary under `.workbench-baseline/<tag>/unbrowse`. If empty, the baseline side is disabled (the proxy still runs; `_workbench_delta.baseline` reports `{ms:0, bytes:0}`).

## Bootstrap

1. Fetch a baseline binary: run Worker B's `scripts/workbench-fetch-baseline.sh` (lands Day 3 alongside this seed). Result: `.workbench-baseline/<prev-tag>/unbrowse`.
2. Set `UNBROWSE_BIN_BASELINE` to that absolute path (`bun` not required; the binary spawns itself).
3. Restart Claude Code or the calling MCP host.

## Hot-swap

`scripts/workbench-swap.sh` (Worker B, Day-4 candidate) sends `SIGHUP` to the proxy. The proxy toggles `liveSide` between `candidate` and `baseline`. Day-3 only wires the signal; the swap-correctness test (AC1) lands Day 4.

## Smoke test

```
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | bun run .claude/mcps/unbrowse-workbench/bin/proxy.ts
```

The framing should hold even if the children fail to start; you will see a JSON-RPC error response on stdout and child-exit lines on stderr.

## Known limitations (Day-3 status)

- `_workbench_delta.diff.structural_diff_summary` is the literal string `"TODO"`. Day-4 (Luminaries) replaces it with a real structural diff.
- No AC1 swap-correctness smoke yet. Days 4-6 wire the bench gate.
- Shell-style command parsing in `src/spawn.ts:parseCommand` is whitespace-split; quoted args with embedded spaces are not handled. Deferred.
- Notifications (id-less messages) from children are dropped. Day-4 decides mirroring semantics for progress / log notifications.
