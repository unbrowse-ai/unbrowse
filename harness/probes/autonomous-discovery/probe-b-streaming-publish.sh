#!/usr/bin/env bash
# Probe B — streaming cross-agent publish.
#
# Agent A drives `unbrowse go` against jmail.world. Agent B (different email
# alias via UNBROWSE_AGENT_EMAIL plus-addressing, fresh local dir) calls
# resolve against the same domain WITHOUT agent A closing or syncing.
#
# Verdict (see JUDGE.md): agent B should get a marketplace hit within ~30s
# end-to-end. Currently expected to FAIL on main — publish is checkpointed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

INTENT="${1:-search emails for dog food}"
URL="${2:-https://jmail.world/search?q=dog+food}"
DOMAIN="$(python3 -c 'import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).netloc)' "$URL")"

ARTIFACT="${OUT_DIR}/probe-b.json"
LOG_A="${OUT_DIR}/probe-b.agent-a.log"
LOG_B="${OUT_DIR}/probe-b.agent-b.log"
RESOLVE_RAW_B="${OUT_DIR}/probe-b.agent-b.resolve.json"
MARKETPLACE_PRE="${OUT_DIR}/probe-b.marketplace.pre.json"
MARKETPLACE_POST="${OUT_DIR}/probe-b.marketplace.post.json"

ensure_server || { echo '{"error":"server_not_up"}' >"$ARTIFACT"; exit 0; }

# Agent identities — same mailbox, plus-addressed for cross-agent isolation.
AGENT_A_EMAIL="${AGENT_A_EMAIL:-unbrowse@unbrowse.ai}"
AGENT_B_EMAIL="${AGENT_B_EMAIL:-unbrowse+probe-b-${RUN_ID}@unbrowse.ai}"

# Fresh agent dir for agent B so it doesn't reuse agent A's local skill cache
AGENT_B_HOME="${OUT_DIR}/agent-b-home"
mkdir -p "$AGENT_B_HOME"

pkill -9 -f 'kuri' 2>/dev/null || true
sleep 1

t_start=$(now_ms)

# Marketplace state BEFORE
marketplace_skill_for_domain "$DOMAIN" "$MARKETPLACE_PRE"

echo "[probe-b] agent A go (email=$AGENT_A_EMAIL)" >&2
UNBROWSE_AGENT_EMAIL="$AGENT_A_EMAIL" \
  $UNBROWSE_BIN go "$URL" >"$LOG_A" 2>&1
go_rc=$?
t_a_go=$(now_ms)

echo "[probe-b] sleep 10s while agent A interceptor accumulates" >&2
sleep 10

# Marketplace state mid-flight (BEFORE agent B resolves)
marketplace_skill_for_domain "$DOMAIN" "${MARKETPLACE_POST}.midflight"

echo "[probe-b] agent B resolve (email=$AGENT_B_EMAIL)" >&2
t_b_resolve_start=$(now_ms)
HOME="$AGENT_B_HOME" \
UNBROWSE_AGENT_EMAIL="$AGENT_B_EMAIL" \
  $UNBROWSE_BIN resolve --intent "$INTENT" --url "$URL" --pretty \
  >"$LOG_B" 2>&1
resolve_b_rc=$?
t_b_resolve_end=$(now_ms)

# Marketplace state AFTER agent B's resolve (publish may have just fired)
marketplace_skill_for_domain "$DOMAIN" "$MARKETPLACE_POST"

extract_last_json "$LOG_B" >"$RESOLVE_RAW_B"

# Process snapshot
kuri_pids="$(pgrep -f 'kuri' 2>/dev/null | tr '\n' ' ')"

python3 - \
  "$ARTIFACT" "$RESOLVE_RAW_B" "$MARKETPLACE_PRE" "$MARKETPLACE_POST" \
  "$INTENT" "$URL" "$DOMAIN" \
  "$AGENT_A_EMAIL" "$AGENT_B_EMAIL" \
  "$t_start" "$t_a_go" "$t_b_resolve_start" "$t_b_resolve_end" \
  "$go_rc" "$resolve_b_rc" "$kuri_pids" \
  "$LOG_A" \
<<'PY'
import sys, json, os
(artifact_path, resolve_raw_path, mkt_pre_path, mkt_post_path,
 intent, url, domain,
 agent_a_email, agent_b_email,
 t_start, t_a_go, t_b_resolve_start, t_b_resolve_end,
 go_rc, resolve_b_rc, kuri_pids,
 log_a_path) = sys.argv[1:18]
def loadj(p):
    try: return json.load(open(p))
    except Exception: return {}
resolve = loadj(resolve_raw_path)
mkt_pre = loadj(mkt_pre_path)
mkt_post = loadj(mkt_post_path)
def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return None
ops = first(resolve, "available_operations", "operations") or []
def mkt_skills(d):
    return d.get("data") or d.get("skills") or []
mkt_pre_n = len(mkt_skills(mkt_pre))
mkt_post_n = len(mkt_skills(mkt_post))
mkt_post_first_published = None
for s in mkt_skills(mkt_post):
    pub = s.get("published_at") or s.get("created_at")
    if pub:
        mkt_post_first_published = pub
        break
artifact = {
    "probe": "B — streaming cross-agent publish",
    "intent": intent,
    "url": url,
    "domain": domain,
    "agent_a": {"email": agent_a_email, "go_exit_code": int(go_rc),
                "log_path": log_a_path,
                "t_go_ms": int(t_a_go) - int(t_start)},
    "agent_b": {
        "email": agent_b_email,
        "resolve_exit_code": int(resolve_b_rc),
        "t_resolve_ms": int(t_b_resolve_end) - int(t_b_resolve_start),
        "t_resolve_started_at_ms": int(t_b_resolve_start) - int(t_start),
        "resolve": {
            "source": first(resolve, "source"),
            "has_available_operations": bool(ops),
            "n_operations": len(ops),
            "top_op": (
                {"operation_id": first(ops[0], "operation_id", "id"),
                 "description": first(ops[0], "description", "summary")}
                if ops else None
            ),
        },
    },
    "marketplace": {
        "n_skills_pre_run": mkt_pre_n,
        "n_skills_post_run": mkt_post_n,
        "first_published_at": mkt_post_first_published,
        "delta": mkt_post_n - mkt_pre_n,
    },
    "kuri_pids_after_run": kuri_pids.split() if kuri_pids.strip() else [],
    "resolve_raw_path": resolve_raw_path,
    "marketplace_pre_path": mkt_pre_path,
    "marketplace_post_path": mkt_post_path,
}
open(artifact_path,"w").write(json.dumps(artifact, indent=2))
PY

append_to_manifest "probe-b-streaming-publish" "$ARTIFACT"

# Cleanup: close agent A's session
UNBROWSE_AGENT_EMAIL="$AGENT_A_EMAIL" $UNBROWSE_BIN close >/dev/null 2>&1 || true
pkill -9 -f 'kuri' 2>/dev/null || true

echo "[probe-b] artifact: $ARTIFACT" >&2
exit 0
