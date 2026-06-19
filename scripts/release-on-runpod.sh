#!/usr/bin/env bash
# release-on-runpod.sh — EPHEMERAL on-demand GitHub Actions runner on RunPod (the manna pattern:
# gathered fresh per release, released after — scale-to-zero, no idle cost).
#
#   up                 -> spin a CPU pod, install tooling + an --ephemeral runner (online for one job)
#   down <pod-id>      -> tear the pod down (scale to zero)
#   release <tag>      -> up, dispatch release.yml for <tag>, wait, then down
#
# Env: REPO (default unbrowse-ai/unbrowse-dev), RUNNER_LABELS (default self-hosted,runpod).
# Requires: runpodctl (authed), gh (repo admin), the RunPod SSH key at ~/.runpod/ssh/RunPod-Key-Go.
set -uo pipefail
REPO="${REPO:-unbrowse-ai/unbrowse-dev}"
LABELS="${RUNNER_LABELS:-self-hosted,runpod}"
SSHKEY="$HOME/.runpod/ssh/RunPod-Key-Go"
TEMPLATE="runpod-ubuntu"   # CPU Ubuntu base WITH sshd
log() { echo "[runpod] $*" >&2; }

pod_ssh() { # $1=ip $2=port ; rest = remote command (stdin piped through)
  local ip="$1" port="$2"; shift 2
  ssh -i "$SSHKEY" -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=25 -o LogLevel=ERROR "root@$ip" "$@"
}

up() {
  log "creating CPU pod from $TEMPLATE ..."
  local pid
  pid="$(runpodctl pod create --compute-type cpu --template-id "$TEMPLATE" --name unbrowse-ci-eph \
        --ports '22/tcp' --container-disk-in-gb 20 --output json 2>/dev/null \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')"
  [ -n "$pid" ] || { log "FAIL: pod not created"; return 1; }
  log "pod $pid — waiting for SSH ..."
  local ip port info
  for _ in $(seq 1 12); do
    info="$(runpodctl ssh info "$pid" 2>/dev/null)"
    ip="$(echo "$info"  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ip",""))' 2>/dev/null)"
    port="$(echo "$info"| python3 -c 'import sys,json;print(json.load(sys.stdin).get("port",""))' 2>/dev/null)"
    [ -n "$ip" ] && [ -n "$port" ] && pod_ssh "$ip" "$port" 'true' 2>/dev/null && break
    sleep 15
  done
  [ -n "${ip:-}" ] && [ -n "${port:-}" ] || { log "FAIL: no SSH"; echo "$pid"; return 1; }
  log "SSH up at $ip:$port — installing runner + tooling ..."
  pod_ssh "$ip" "$port" 'bash -s' <<'REMOTE' >&2
set -e
export DEBIAN_FRONTEND=noninteractive RUNNER_ALLOW_RUNASROOT=1
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl tar jq git build-essential libicu66 >/dev/null 2>&1 || apt-get install -y -qq curl tar jq git >/dev/null 2>&1
command -v bun >/dev/null || (curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true)
mkdir -p ~/actions-runner && cd ~/actions-runner
if [ ! -f ./config.sh ]; then
  V=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
  curl -sL -o r.tar.gz "https://github.com/actions/runner/releases/download/v${V}/actions-runner-linux-x64-${V}.tar.gz"
  tar xzf r.tar.gz && rm r.tar.gz
fi
REMOTE
  # register an EPHEMERAL runner (one job then self-removes); token piped via stdin (never in args)
  log "registering ephemeral runner ..."
  gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token 2>/dev/null | \
    pod_ssh "$ip" "$port" "RT=\$(cat); cd ~/actions-runner && RUNNER_ALLOW_RUNASROOT=1 ./config.sh \
      --url https://github.com/$REPO --token \"\$RT\" --name eph-$pid --labels $LABELS \
      --ephemeral --unattended --replace && \
      ( setsid bash -c 'RUNNER_ALLOW_RUNASROOT=1 ./run.sh >runner.log 2>&1' </dev/null >/dev/null 2>&1 & ) && \
      sleep 3 && echo 'runner-launched'" >&2
  log "ephemeral runner eph-$pid started"
  echo "$pid"
}

down() { local pid="$1"; log "tearing down pod $pid ..."; (runpodctl pod delete "$pid" || runpodctl remove pod "$pid") >&2 2>&1; }

release() {
  local tag="$1"; local pid; pid="$(up)" || { [ -n "$pid" ] && down "$pid"; return 1; }
  log "dispatching release.yml for $tag (ephemeral runner will take the job) ..."
  gh workflow run release.yml -f tag="$tag" >&2 2>&1 || log "dispatch failed"
  log "waiting for the ephemeral runner to consume the job + the build to finish ..."
  for _ in $(seq 1 60); do
    npm view "unbrowse@${tag#v}" version >/dev/null 2>&1 && { log "published unbrowse@${tag#v}"; break; }
    sleep 30
  done
  down "$pid"
}

case "${1:-}" in
  up) up ;;
  down) down "${2:?pod-id}" ;;
  release) release "${2:?tag}" ;;
  *) echo "usage: $0 {up|down <pod-id>|release <tag>}" >&2; exit 2 ;;
esac
