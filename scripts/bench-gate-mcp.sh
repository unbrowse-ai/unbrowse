#!/usr/bin/env bash
# bench-gate-mcp.sh — MCP-driven subagent release-gate harness.
#
# What this fixes vs. scripts/bench-gate.sh:
#   The old gate runs one `unbrowse capture` per probe — a single CLI shortcut
#   that conflates browse + index + publish. The new gate measures what
#   real agents actually do over MCP: a full loop of
#     unbrowse_resolve -> unbrowse_go -> snap/eval -> unbrowse_close (publish)
#     -> unbrowse_resolve (verify) -> unbrowse_execute
#   repeated N times PER PROBE so stability is observable (not just one-shot
#   luck), every probe starts from an EMPTY skill index (clean slate), and
#   every loop iteration is driven by an LLM subagent the parent fans out
#   via the Agent tool.
#
# Per CLAUDE.md "harness makes visible, agent judges" / memory
# `feedback_harness_makes_visible_agent_judges.md`: this script never opens
# an LLM and never renders a verdict. It preps the inputs (subagent prompt
# files, manifest, clean-index env) and exits. The PARENT agent running
# this script reads the manifest and spawns one Agent-tool call per probe.
#
# Output layout:
#   .bench-gate/<run-id>/
#     manifest.json                   — probes[] + clean_slate state + env
#     fanout-instructions.md          — copy-paste plan for the parent agent
#     <probe-id>/
#       subagent.prompt.md            — the prompt for one Agent-tool call
#       subagent.context.json         — { probe_id, intent, url, result_path, ... }
#       subagent.result.json          — the subagent writes this; harness reads it
#       subagent.log                  — optional transcript for debugging
#
# Usage:
#   bash scripts/bench-gate-mcp.sh                       # default corpus
#   bash scripts/bench-gate-mcp.sh --corpus FILE         # custom
#   bash scripts/bench-gate-mcp.sh --iterations 5        # default 3
#   bash scripts/bench-gate-mcp.sh --limit 10            # stop after N probes
#   bash scripts/bench-gate-mcp.sh --keep-index          # don't wipe (debugging only)

set -uo pipefail

CORPUS="${CORPUS:-harness/probes/corpus-gate.txt}"
OUT_DIR="${OUT_DIR:-.bench-gate}"
ITERATIONS="${ITERATIONS:-3}"
LIMIT="${LIMIT:-0}"
KEEP_INDEX=0
ACK_SEQUENTIAL_FLAG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus)          CORPUS="$2"; shift 2 ;;
    --iterations)      ITERATIONS="$2"; shift 2 ;;
    --limit)           LIMIT="$2"; shift 2 ;;
    --keep-index)      KEEP_INDEX=1; shift ;;
    --ack-sequential)  ACK_SEQUENTIAL_FLAG=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ ! -f "$CORPUS" ]; then
  echo "[bench-gate-mcp] FATAL corpus not found: $CORPUS" >&2
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUT_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"

err() { echo "[bench-gate-mcp] $*" >&2; }

# ── 1. Clean-slate the local skill index ─────────────────────────────────
# Each probe MUST start from empty so the test exercises the real
# discovery path (browse + index + publish). If skills are cached the
# loop short-circuits at resolve and the harness measures cache hit
# rates, not pipeline robustness.
SKILL_SNAPSHOT_DIR="${HOME}/.unbrowse/skill-snapshots"
QUEUE_DIR="${HOME}/.unbrowse/queue/pending"
ROUTE_CACHE_DIR="${HOME}/.unbrowse/route-cache"

if [ "$KEEP_INDEX" = "0" ]; then
  err "wiping local skill index for clean-slate run"
  # Don't rm -rf the parent (which holds the vault) — only the indexable
  # snapshots / queue / route cache.
  if [ -d "$SKILL_SNAPSHOT_DIR" ]; then
    find "$SKILL_SNAPSHOT_DIR" -maxdepth 1 -name '*.json' -delete 2>/dev/null || true
    err "cleared $SKILL_SNAPSHOT_DIR"
  fi
  if [ -d "$QUEUE_DIR" ]; then
    find "$QUEUE_DIR" -maxdepth 1 \( -name '*.json' -o -name '*.lock' -o -name '.heartbeat' \) -delete 2>/dev/null || true
    err "cleared $QUEUE_DIR"
  fi
  if [ -d "$ROUTE_CACHE_DIR" ]; then
    find "$ROUTE_CACHE_DIR" -maxdepth 2 -name '*.json' -delete 2>/dev/null || true
    err "cleared $ROUTE_CACHE_DIR"
  fi
else
  err "--keep-index set: skipping wipe (DEBUGGING ONLY, not for release gate)"
fi

# ── 2. Parse corpus into per-probe records ────────────────────────────────
probes_jsonl="$RUN_DIR/.probes.jsonl"
: > "$probes_jsonl"
i=0
while IFS='|' read -r lane c2 c3 c4 c5 c6 _rest; do
  lane="${lane## }"; lane="${lane%% }"
  case "$lane" in ''|\#*) continue ;; esac
  if [ -n "${c6:-}" ]; then
    auth="${c2## }"; auth="${auth%% }"
    difficulty="${c3## }"; difficulty="${difficulty%% }"
    strategy="${c4## }"; strategy="${strategy%% }"
    intent="${c5## }"; intent="${intent%% }"
    url="${c6## }"; url="${url%% }"
  else
    auth=""
    difficulty=""
    strategy=""
    intent="${c2## }"; intent="${intent%% }"
    url="${c3## }"; url="${url%% }"
  fi
  i=$((i+1))
  if [ "$LIMIT" -gt 0 ] && [ "$i" -gt "$LIMIT" ]; then break; fi
  probe_id="$(printf '%03d_%s' "$i" "$lane")"
  jq -nc \
    --arg probe_id "$probe_id" \
    --arg lane "$lane" \
    --arg auth "$auth" \
    --arg difficulty "$difficulty" \
    --arg strategy "$strategy" \
    --arg intent "$intent" \
    --arg url "$url" \
    '{probe_id: $probe_id, lane: $lane, auth: $auth, difficulty: $difficulty, strategy: $strategy, intent: $intent, url: $url}' \
    >> "$probes_jsonl"
done < "$CORPUS"
n_probes=$(wc -l < "$probes_jsonl" | tr -d ' ')
err "queued $n_probes probe(s)"

# ── 2.5. Enforce per-session-Kuri so concurrent subagent fan-out doesn't
#        cross-bind tabs or leak metadata between sessions ───────────────
# Per CLAUDE.md "Parallel gate collection" the per-session Kuri broker
# (UNBROWSE_PER_SESSION_KURI=1) is what stops the conc>=4 cross-talk
# observed in real bench-gate runs (see .bench-gate/20260517T213540Z
# probes #006 and #012). Without it, concurrent /v1/browse/go calls
# share a broker create-lock and the tab one subagent opens can bind
# to another subagent's session. The prep script can't enable this
# itself — the env must be set on the running unbrowse MCP server
# process — so we surface the requirement loudly here and refuse to
# pretend the resulting gate is reliable.
if [ "${UNBROWSE_PER_SESSION_KURI:-0}" != "1" ] && [ "${UNBROWSE_PER_SESSION_KURI:-}" != "true" ]; then
  err ""
  err "WARNING: UNBROWSE_PER_SESSION_KURI is NOT set in this prep-script env."
  err ""
  err "  The MCP-driven gate fans out subagents in parallel batches; without"
  err "  per-session-Kuri the broker create-lock cross-binds tabs and"
  err "  produces false-positive failures (proven in run 20260517T213540Z)."
  err ""
  err "  Set it on the unbrowse MCP server process before the subagents fire:"
  err "    export UNBROWSE_PER_SESSION_KURI=1"
  err "    pkill -9 -f 'unbrowse|kuri'; sleep 2"
  err "    # the MCP client (Claude Code) will reconnect on next tool call"
  err ""
  err "  If you are deliberately running sequentially (batch size 1) the env"
  err "  is not required — re-run with --ack-sequential to suppress this warning."
  err ""
  if [ "$ACK_SEQUENTIAL_FLAG" != "1" ] && [ "${ACK_SEQUENTIAL:-0}" != "1" ]; then
    err "Aborting. Set the env (or --ack-sequential) and retry."
    exit 3
  fi
fi

# ── 3. Write per-probe subagent prompts + context ────────────────────────
while IFS= read -r row; do
  probe_id=$(jq -r '.probe_id' <<<"$row")
  lane=$(jq -r '.lane' <<<"$row")
  intent=$(jq -r '.intent' <<<"$row")
  url=$(jq -r '.url' <<<"$row")
  auth=$(jq -r '.auth' <<<"$row")
  difficulty=$(jq -r '.difficulty' <<<"$row")
  strategy=$(jq -r '.strategy' <<<"$row")
  pdir="$RUN_DIR/$probe_id"
  mkdir -p "$pdir"

  # Context the subagent reads to know what to do + where to write
  jq -nc \
    --arg probe_id "$probe_id" \
    --arg lane "$lane" \
    --arg auth "$auth" \
    --arg difficulty "$difficulty" \
    --arg strategy "$strategy" \
    --arg intent "$intent" \
    --arg url "$url" \
    --arg result_path "$pdir/subagent.result.json" \
    --arg log_path "$pdir/subagent.log" \
    --argjson iterations "$ITERATIONS" \
    '{probe_id: $probe_id, lane: $lane, auth: $auth, difficulty: $difficulty,
      strategy: $strategy, intent: $intent, url: $url,
      iterations: $iterations,
      result_path: $result_path, log_path: $log_path}' \
    > "$pdir/subagent.context.json"

  # The prompt itself — what the subagent will receive verbatim.
  # No prescription of correct outcomes; the subagent describes what
  # happened and the parent judges.
  cat > "$pdir/subagent.prompt.md" <<EOF
You are a bench-gate subagent running ONE release-gate probe end-to-end via
the unbrowse MCP server. The probe is below; run it ${ITERATIONS} times
(iterations 1..${ITERATIONS}) and write a single JSON result at the end.

## Probe

- probe_id: ${probe_id}
- lane: ${lane}
- intent: ${intent}
- url: ${url}
$( [ -n "$auth" ] && echo "- auth: ${auth}" )
$( [ -n "$difficulty" ] && echo "- difficulty: ${difficulty}" )
$( [ -n "$strategy" ] && echo "- strategy: ${strategy}" )

## What "ran" means

For each iteration N in 1..${ITERATIONS}, perform exactly this loop using
the unbrowse MCP tools. Do NOT use the unbrowse CLI; only mcp__unbrowse__*.

1. \`mcp__unbrowse__unbrowse_resolve\` with { intent: "...", contextUrl: "..." }.
   - If a non-empty available_endpoints list comes back, record
     pre_index_resolve="HIT" and you may either (a) skip the browse step
     for this iteration (treat as cache hit; report stability that way)
     or (b) wipe by calling \`unbrowse_close\` if any session is open
     and continue.
   - If empty, record pre_index_resolve="MISS" and continue.
2. \`mcp__unbrowse__unbrowse_go\` with { url: "..." }. Wait for it to return.
3. \`mcp__unbrowse__unbrowse_snap\` (and optionally \`unbrowse_eval\` /
   \`unbrowse_click\` / \`unbrowse_scroll\` / \`unbrowse_fill\` /
   \`unbrowse_press\` / \`unbrowse_submit\`) to give the page time to
   load and to interact if the intent needs it (e.g. a search box).
4. \`mcp__unbrowse__unbrowse_close\`. This triggers index + publish.
5. \`mcp__unbrowse__unbrowse_resolve\` AGAIN with the same intent + url.
   Record whether the just-published skill now resolves (post_index_resolve).
6. \`mcp__unbrowse__unbrowse_execute\` with the picked skill_id +
   endpoint_id + raw=true. Record status_code, response_bytes, and
   whether the response body looks relevant to the intent.

## Outcome labels (per-iteration)

Pick ONE of: PASS, FAIL_BROWSE, FAIL_INDEX_NO_ENDPOINTS,
FAIL_PUBLISH_NOT_VISIBLE, FAIL_RESOLVE_AFTER_PUBLISH,
FAIL_EXECUTE_ERROR, FAIL_EXECUTE_EMPTY, EXCLUDED_AUTH, EXCLUDED_BLOCKED.

Classification rules — pick the LABEL that matches the evidence, not
the shape of the HTTP error:

- \`EXCLUDED_BLOCKED\` — execute or any phase returned an anti-bot
  refusal: HTTP 403 with no auth attempted; HTTP 429 sustained;
  vendor-named challenge (cloudflare / perimeterx / datadome /
  imperva / akamai / kasada); response body containing "Access
  Denied", "Please verify you are a human", "challenge", "blocked";
  or trace evidence the request looked like a server-side fetch
  the site refused. Treat reddit / x.com / instagram 403 the same
  way unless your trace shows a real bug. This is NOT a unbrowse
  failure; the site refused automation.
- \`EXCLUDED_AUTH\` — site clearly gates the data behind login;
  resolve / execute surfaced an auth_required signal; cookies
  absent or expired. NOT a unbrowse failure.
- \`FAIL_EXECUTE_ERROR\` — execute returned a non-2xx and the
  response body is NOT an anti-bot refusal AND NOT an auth gate.
  Real bug. Capture the trace.
- \`FAIL_EXECUTE_EMPTY\` — execute returned 2xx but the body is
  empty or obviously irrelevant to the intent. Real bug.
- \`PASS\` — empty resolve, browse OK, publish OK,
  resolve-after-publish saw the new skill, execute returned data
  you judge relevant.

You judge from the evidence you collected (snap content, response
bytes, status codes, decision_trace). The parent will read your
reasoning, not just the label.

## Stability label (across iterations)

After all ${ITERATIONS} iterations:
- STABLE if all iterations have the same outcome
- FLAKY if outcomes vary across iterations
- UNSTABLE if any iteration crashed or timed out without a clean outcome

## Final write

Write a single JSON object to: \`${pdir}/subagent.result.json\`. Schema:

\`\`\`json
{
  "probe_id": "${probe_id}",
  "lane": "${lane}",
  "intent": "${intent}",
  "url": "${url}",
  "iterations": [
    {
      "iteration": 1,
      "pre_index_resolve": "MISS|HIT|ERROR",
      "phases": {
        "browse": { "status": "ok|fail", "ms": 0, "notes": "..." },
        "publish": { "status": "ok|fail", "endpoints_published": 0 },
        "resolve_after_publish": { "available_endpoints": 0, "skill_id": "..." },
        "execute": { "status_code": 0, "response_bytes": 0, "looks_relevant": true }
      },
      "outcome": "PASS|FAIL_*|EXCLUDED_*",
      "evidence_quote": "<= 200 chars of the most relevant response/snap excerpt"
    }
  ],
  "stability": "STABLE|FLAKY|UNSTABLE",
  "summary": "1-2 sentences"
}
\`\`\`

## Rules

- Use ONLY the mcp__unbrowse__* tools for unbrowse calls. No CLI, no curl.
- Do not invent outcomes. If a phase did not produce evidence, label it
  fail and say why.
- Keep evidence_quote short. The parent reads the full
  \`subagent.result.json\` and the on-disk subagent.log if present.
- Do not write any other files.
- This is one probe; you are one of many subagents the parent fanned
  out in parallel. Each probe is independent — do not assume anything
  about other probes or shared state beyond the clean-slate index.
EOF
done < "$probes_jsonl"

# ── 4. Manifest ───────────────────────────────────────────────────────────
cli_version="$(bun src/cli.ts --version 2>/dev/null || echo unknown)"
node_version="$(node --version 2>/dev/null || echo unknown)"

probes_array="$(jq -s . "$probes_jsonl")"
jq -nc \
  --arg run_id "$RUN_ID" \
  --arg corpus "$CORPUS" \
  --arg cli_version "$cli_version" \
  --arg node_version "$node_version" \
  --arg started "$(date -u +%FT%TZ)" \
  --argjson iterations "$ITERATIONS" \
  --argjson keep_index "$KEEP_INDEX" \
  --argjson probes "$probes_array" \
  '{run_id: $run_id, corpus: $corpus, cli_version: $cli_version,
    node_version: $node_version, started_at: $started,
    iterations: $iterations, clean_slate: ($keep_index == 0),
    transport: "mcp", driver: "subagent",
    probes: $probes}' \
  > "$RUN_DIR/manifest.json"

rm -f "$probes_jsonl"

# ── 5. Fanout instructions for the parent agent ──────────────────────────
cat > "$RUN_DIR/fanout-instructions.md" <<EOF
# Bench-gate fanout instructions

Run ID: ${RUN_ID}
Probes: ${n_probes}
Iterations per probe: ${ITERATIONS}
Clean-slate index: $([ "$KEEP_INDEX" = "0" ] && echo yes || echo no)
Transport: unbrowse MCP

## What to do next

You (the parent agent) must spawn ${n_probes} Agent-tool calls — one per
probe directory in this run. Each Agent receives the contents of
\`<probe-dir>/subagent.prompt.md\` and writes \`<probe-dir>/subagent.result.json\`.

Fan out in batches of 4-6 to keep MCP load sane (the unbrowse MCP server
launches a per-session Kuri broker per Agent; >6 concurrent is
known-flaky on macOS — see CLAUDE.md "Parallel gate collection").

Per-probe Agent call shape (general-purpose subagent_type recommended):

\`\`\`
Agent({
  subagent_type: "general-purpose",
  description: "bench-gate probe <probe_id>",
  prompt: <contents of <probe-dir>/subagent.prompt.md>
})
\`\`\`

When all subagents complete:

1. \`bun scripts/bench-gate-mcp-collect.ts --artifacts ${RUN_DIR}\`
   — sweeps every \`<probe-dir>/subagent.result.json\` into a single
   \`${RUN_DIR}/verdict.json\` shape compatible with bench-gate-compare.
2. \`bun scripts/bench-gate-judge.ts --validate --artifacts ${RUN_DIR}\`
   — schema check the consolidated verdict.
3. \`bun scripts/bench-gate-compare.ts --artifacts ${RUN_DIR} --stamp\`
   — diff against baseline + write stamp.json if all gates pass.
4. \`git add .bench-gate/stamp.json && git commit -m "chore: bench-gate stamp \${RUN_ID}"\`
   — commit the stamp so the release script can read it.

## Why this exists

The previous gate ran one \`unbrowse capture\` CLI call per probe — a
single shortcut that bypassed the realistic MCP loop agents actually
use. This gate measures what an agent talking to unbrowse over MCP
would experience: empty index, full discover+publish+retrieve+execute
loop, repeated for stability. See \`docs/release-gate-bench-plan.md\`
for the underlying principle.
EOF

err "wrote $n_probes prompt files to $RUN_DIR/<probe-id>/subagent.prompt.md"
err "manifest -> $RUN_DIR/manifest.json"
err "next steps -> $RUN_DIR/fanout-instructions.md"
printf '%s\n' "$RUN_DIR"
