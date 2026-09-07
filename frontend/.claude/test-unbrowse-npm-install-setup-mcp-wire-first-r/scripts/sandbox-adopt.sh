#!/usr/bin/env bash
# sandbox-adopt.sh - drive unbrowse adoption journey end-to-end inside a fresh
# podman container. Captures per-step exit + wallclock + stderr-tail + the agent-
# visible output to artifacts/<step>.{out,err,meta.json}. NO heuristic verdicts:
# the agent reads the artifacts in-thread and judges.
set -uo pipefail

SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
ART="$SCAFFOLD/artifacts/wave-$(date -u +%Y%m%dT%H%M%SZ)"
IMG=unbrowse-adopt-sandbox:latest
CONTAINER=unbrowse-adopt-$$
mkdir -p "$ART"

echo "[sandbox-adopt] artifacts: $ART"
echo "[sandbox-adopt] image:     $IMG"
echo "[sandbox-adopt] container: $CONTAINER"

step() {
  local name="$1"; shift
  local cmd="$*"
  local out="$ART/$name.out"
  local err="$ART/$name.err"
  local meta="$ART/$name.meta.json"
  local t0 t1
  echo
  echo "[step] $name: $cmd"
  t0=$(python3 -c 'import time; print(time.time())')
  set +e
  eval "$cmd" >"$out" 2>"$err"
  local rc=$?
  set -e
  t1=$(python3 -c 'import time; print(time.time())')
  local secs
  secs=$(python3 -c "print(f'{$t1 - $t0:.3f}')")
  python3 - <<PY
import json, os
meta = {
  "step": "$name",
  "cmd":  """$cmd""",
  "exit_code": $rc,
  "wallclock_s": float("$secs"),
  "out_path": "$out",
  "err_path": "$err",
  "out_bytes": os.path.getsize("$out"),
  "err_bytes": os.path.getsize("$err"),
}
open("$meta","w").write(json.dumps(meta, indent=2))
PY
  echo "  exit=$rc  wall=${secs}s  out=$(wc -c <"$out")B  err=$(wc -c <"$err")B"
  return 0
}

cleanup() {
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "00-build-image" "podman build -t '$IMG' -f '$SCAFFOLD/scripts/Dockerfile.sandbox' '$SCAFFOLD/scripts/'"
step "01-spawn-container" "podman run -d --name '$CONTAINER' '$IMG' sleep 3600"
step "02-npm-install-global" "podman exec '$CONTAINER' bash -lc 'npm install -g unbrowse@latest 2>&1'"
step "03-version" "podman exec '$CONTAINER' bash -lc 'unbrowse --version 2>&1 || unbrowse upgrade 2>&1'"
step "04-help" "podman exec '$CONTAINER' bash -lc 'unbrowse --help 2>&1 | head -120'"
step "05-setup-noninteractive" "podman exec '$CONTAINER' bash -lc 'unbrowse setup --no-claude-register --skip-browser --opencode off 2>&1'"
step "06-health" "podman exec '$CONTAINER' bash -lc 'unbrowse health 2>&1'"
step "07-resolve-hn" "podman exec '$CONTAINER' bash -lc 'unbrowse resolve --intent \"top stories on hackernews\" --url https://news.ycombinator.com --no-execute 2>&1 | head -200'"
step "08-skills-list" "podman exec '$CONTAINER' bash -lc 'unbrowse skills 2>&1 | head -40'"
step "09-mcp-help" "podman exec '$CONTAINER' bash -lc 'unbrowse mcp --help 2>&1 | head -30 || true'"
step "10-error-no-intent" "podman exec '$CONTAINER' bash -lc 'unbrowse resolve 2>&1 || true'"
step "11-error-no-skill" "podman exec '$CONTAINER' bash -lc 'unbrowse execute 2>&1 || true'"
step "12-error-no-url-go" "podman exec '$CONTAINER' bash -lc 'unbrowse go 2>&1 || true'"

python3 - <<PY
import json, os, glob
art = "$ART"
steps = []
for meta_path in sorted(glob.glob(os.path.join(art, "*.meta.json"))):
    with open(meta_path) as f:
        meta = json.load(f)
    out_path = meta.get("out_path", "")
    err_path = meta.get("err_path", "")
    if out_path and os.path.exists(out_path):
        with open(out_path, errors="replace") as f:
            meta["out_excerpt"] = f.read(4096)
    if err_path and os.path.exists(err_path):
        with open(err_path, errors="replace") as f:
            meta["err_excerpt"] = f.read(4096)
    steps.append(meta)
manifest = {
  "wave_dir": art,
  "image": "$IMG",
  "container": "$CONTAINER",
  "ts": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
  "step_count": len(steps),
  "steps": steps,
}
out = os.path.join(art, "manifest.json")
open(out, "w").write(json.dumps(manifest, indent=2))
print(f"[sandbox-adopt] manifest: {out}")
print(f"[sandbox-adopt] steps:    {len(steps)}")
PY

echo
echo "[sandbox-adopt] DONE. Read $ART/manifest.json + per-step .out / .err."
