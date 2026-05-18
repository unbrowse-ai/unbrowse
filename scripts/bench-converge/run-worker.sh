#!/usr/bin/env bash
# One bench-converge worker. Spawned in parallel (xargs -P) by orchestrate.sh.
#
# Args (positional, from xargs):
#   $1  probe_id
#
# Reads from env (exported by orchestrate.sh):
#   RUN_DIR, REPO, CODEX_BIN, DRY_RUN, PROBES_JSONL, WORKER_TIMEOUT_S
#
# Side effects (per-probe, isolated):
#   $RUN_DIR/probes/<probe_id>/.unbrowse-state/        — sandboxed UNBROWSE_HOME (per CLAUDE.md)
#   $RUN_DIR/probes/<probe_id>/codex-trace.jsonl       — codex --json event stream (every tool call)
#   $RUN_DIR/probes/<probe_id>/result.json             — verdict JSON (worker prompt contract)
#   $RUN_DIR/probes/<probe_id>/last-message.txt        — final assistant message
#   $RUN_DIR/probes/<probe_id>/codex.exit              — codex exit code
#
# Per CLAUDE.md "Parallel gate collection": each worker spawns its OWN
# `bun src/mcp.ts` via [mcp_servers.unbrowse] (codex behavior), so we
# don't share an MCP server across workers — the only shared resource
# is the host's CPU/memory and any global cache the source code may
# touch. UNBROWSE_HOME is overridden per-worker via `-c` so no two
# workers can race on the same skill-snapshot / queue / route-cache.
set -uo pipefail

probe_id="${1:?probe_id required}"
: "${RUN_DIR:?RUN_DIR required}"
: "${REPO:?REPO required}"
: "${PROBES_JSONL:?PROBES_JSONL required}"
DRY_RUN="${DRY_RUN:-0}"
CODEX_BIN="${CODEX_BIN:-codex}"
WORKER_TIMEOUT_S="${WORKER_TIMEOUT_S:-300}"

pdir="$RUN_DIR/probes/$probe_id"
mkdir -p "$pdir/.unbrowse-state"
rp="$pdir/result.json"
lp="$pdir/last-message.txt"
trace="$pdir/codex-trace.jsonl"
ecode="$pdir/codex.exit"

row="$(jq -c --arg p "$probe_id" 'select(.probe_id==$p)' < "$PROBES_JSONL" | head -n 1)"
if [ -z "$row" ]; then
  echo "[run-worker] no row for $probe_id" >&2
  exit 2
fi
lane="$(jq -r '.lane'   <<<"$row")"
intent="$(jq -r '.intent' <<<"$row")"
url="$(jq -r '.url'    <<<"$row")"

if [ "$DRY_RUN" = "1" ]; then
  jq -nc --arg pid "$probe_id" --arg lane "$lane" --arg intent "$intent" --arg url "$url" \
    '{probe_id:$pid, lane:$lane, intent:$intent, url:$url,
      phases:{browse_close:{indexed:true, mode:"http", skill_id:"dryrun"}},
      outcome:"PASS", outcome_reason:"dry-run synthetic"}' > "$rp"
  echo 0 > "$ecode"
  exit 0
fi

prompt="$(sed \
  -e "s|{{PROBE_ID}}|$probe_id|g" \
  -e "s|{{LANE}}|$lane|g" \
  -e "s|{{INTENT}}|$intent|g" \
  -e "s|{{URL}}|$url|g" \
  -e "s|{{RESULT_PATH}}|$rp|g" \
  -e "s|{{LOG_PATH}}|$lp|g" \
  "$REPO/scripts/bench-converge/prompts/probe-worker.md")"

# Per-worker isolation: override UNBROWSE_HOME on this codex invocation's
# MCP server config so its bun src/mcp.ts process owns a distinct state
# dir. Without this, 50 workers race on ~/.unbrowse/* and the gate
# measures lock contention, not the agent path.
abs_state="$pdir/.unbrowse-state"
mcp_env_override="mcp_servers.unbrowse.env={ UNBROWSE_HOME = \"$abs_state\", HEADLESS = \"true\", KURI_HEADLESS = \"true\", UNBROWSE_PER_SESSION_KURI = \"1\" }"

# Timeout: kill the worker if it exceeds the bound (e.g. anti-bot 60s
# spin lock). codex's own timeout setting isn't a CLI flag, so we wrap.
timeout --foreground "$WORKER_TIMEOUT_S" \
  "$CODEX_BIN" exec \
    --yolo \
    --cd "$REPO" \
    --json \
    --output-last-message "$lp" \
    -c "$mcp_env_override" \
    "$prompt" \
  > "$trace" 2>&1
ec=$?
echo "$ec" > "$ecode"

# Worker MUST have written result.json per the prompt contract. If not
# (codex gave up, timed out, errored before writing), synthesize a
# minimal result so the ledger row is honest.
if [ ! -s "$rp" ]; then
  jq -nc --arg pid "$probe_id" --arg lane "$lane" --arg intent "$intent" --arg url "$url" \
        --arg reason "codex exited $ec without writing result.json (timeout=$WORKER_TIMEOUT_S s)" \
    '{probe_id:$pid, lane:$lane, intent:$intent, url:$url,
      phases:{}, outcome:"WORKER_CRASH", outcome_reason:$reason}' > "$rp"
fi

exit 0   # always succeed at the bash level; orchestrator reads result.json
