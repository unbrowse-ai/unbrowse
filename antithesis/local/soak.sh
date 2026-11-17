#!/usr/bin/env bash
# The harness run locally, with no Antithesis tenant: brings the topology up, runs the test commands the way a
# timeline composes them while nemesis.sh injects faults, stops the faults, runs the eventually_ and finally_
# commands, and reads back every assertion the SDKs recorded (summarise.py).
#
#   antithesis/local/soak.sh                 from the repo root; Linux amd64, podman (or docker) and Compose v2
#
#   SOAK_SEED     one seed for the whole run (default: the time): it seeds the nemesis and every test command's
#                 choices (the SDK's random falls back on Python's random outside Antithesis), so the same seed and
#                 profile replay the same faults and the same driver decisions; interleavings stay the machine's
#   SOAK_MINUTES  driver time with faults (default 20)     FAULTS=0  no nemesis (a fault-free run)
#   BUILD=0       reuse the images already built            NEMESIS_GAP, NEMESIS_KINDS  the fault profile, see nemesis.sh
#   OUT           where logs and assertions land (default antithesis/local/out, git-ignored)
#   KNOWN         violations already filed, one assertion message per line (default local/known-violations.txt):
#                 they are listed as KNOWN and do not fail the run
#
# Prints ANTITHESIS_LOCAL_SOAK_PASSED when no Always, AlwaysOrUnreachable or Unreachable was violated beyond KNOWN;
# otherwise ANTITHESIS_LOCAL_SOAK_FAILED with the count and the command that replays it, and exits 1. A Sometimes that
# never came true is listed, not failed: it says what the run didn't reach. OUT/run.env holds the seed and profile,
# OUT/schedule.tsv every fault, OUT/coverage.txt every Sometimes and Reachable that came true.
set -u
cd "$(dirname "$0")/../.."
HERE=antithesis/local
OUT=${OUT:-$HERE/out}
MIN=${SOAK_MINUTES:-20}
SEED=${SOAK_SEED:-$(date +%s)}
KNOWN=${KNOWN:-$HERE/known-violations.txt}
C=(podman compose -f antithesis/config/docker-compose.yaml -f "$HERE/override.yaml")
command -v podman >/dev/null || C=(docker compose -f antithesis/config/docker-compose.yaml -f "$HERE/override.yaml")
T=/opt/antithesis/test/v1/unbrowse
log() { echo "== $(date -u +%FT%TZ) $*"; }

rm -rf "$OUT"; mkdir -p "$OUT/sdk"
printf 'SOAK_SEED=%s SOAK_MINUTES=%s FAULTS=%s NEMESIS_GAP=%s NEMESIS_KINDS=%s\n' "$SEED" "$MIN" "${FAULTS:-1}" "${NEMESIS_GAP:-20}" "${NEMESIS_KINDS:-}" > "$OUT/run.env"
log "seed $SEED"
if [ "${BUILD:-1}" = 1 ]; then log build; "${C[@]}" build > "$OUT/build.log" 2>&1 || { tail -20 "$OUT/build.log"; log BUILD_FAILED; exit 1; }; fi
"${C[@]}" down -v > /dev/null 2>&1
"${C[@]}" up -d > "$OUT/up.log" 2>&1 || { tail -20 "$OUT/up.log"; log UP_FAILED; exit 1; }
for _ in $(seq 1 120); do
  podman logs unbrowse-workload 2>&1 | grep -q 'workload setup: setup complete' && break
  podman ps -a --format '{{.Names}} {{.Status}}' | grep -qE '^unbrowse-.*Exited' && { log CONTAINER_EXITED; break; }
  sleep 5
done
podman logs unbrowse-workload 2>&1 | grep -q 'setup complete' || { podman logs unbrowse-workload 2>&1 | tail -20; log SETUP_FAILED; "${C[@]}" down -v > /dev/null 2>&1; exit 1; }
log "setup complete"

SEEDED='import os, random, runpy, sys; random.seed(int(sys.argv[1])); sys.argv = sys.argv[2:]; sys.path.insert(0, os.path.dirname(sys.argv[0])); runpy.run_path(sys.argv[0], run_name="__main__")'
k=0
run() {  # one test command, its assertions to its own file, its choices seeded from SEED and its place in the run
  k=$((k + 1))
  podman exec -e "ANTITHESIS_SDK_LOCAL_OUTPUT=/state/sdk-$1.jsonl" unbrowse-workload \
    timeout 900 python3 -c "$SEEDED" "$(( (SEED * 1000003 + ${2:-$k}) % 4294967296 ))" "$T/$1" >> "$OUT/commands.log" 2>&1
  local rc=$?; [ $rc -ne 0 ] && log "$1 exit $rc"
}

STOP=$(mktemp -u "${TMPDIR:-/tmp}/unbrowse-nemesis.XXXXXX")
if [ "${FAULTS:-1}" = 1 ]; then
  NEMESIS_SEED=$SEED NEMESIS_SCHEDULE="$OUT/schedule.tsv" NEMESIS_STOP=$STOP "$HERE/nemesis.sh" > "$OUT/nemesis.log" 2>&1 &
  NEMESIS=$!
  log "faults on (nemesis $NEMESIS)"
fi
end=$(( $(date +%s) + MIN * 60 )); n=0
while [ "$(date +%s)" -lt "$end" ]; do
  pids=(); s=0
  for d in parallel_driver_call.py parallel_driver_call.py parallel_driver_owner.py; do s=$((s + 1)); run "$d" "$((n * 10 + s))" & pids+=($!); done
  wait "${pids[@]}"  # never a bare wait: that would also wait on nemesis, which runs until told to stop
  n=$((n + 1))
  [ $((n % 6)) -eq 0 ] && run singleton_driver_epoch.py "$((n * 10 + 7))"
  [ $((n % 3)) -eq 0 ] && run anytime_settlement_invariants.py "$((n * 10 + 8))"
  sleep 3
done
if [ -n "${NEMESIS:-}" ]; then touch "$STOP"; wait "$NEMESIS"; rm -f "$STOP"; log "faults off: $(grep -c . "$OUT/schedule.tsv" 2>/dev/null || echo 0) faults"; fi
log "$n driver rounds; quiet 60 s"
sleep 60
run eventually_network_recovers.py; run eventually_lines_claimed.py; run finally_settlement_and_bounds.py

for n in 1 2 3; do
  podman cp "unbrowse-node-$n:/data/sdk-node.jsonl" "$OUT/sdk/node-$n.jsonl" 2>/dev/null
  podman logs "unbrowse-node-$n" > "$OUT/node-$n.log" 2>&1
done
podman exec unbrowse-workload sh -c 'ls /state/*.jsonl' | while read -r f; do podman cp "unbrowse-workload:$f" "$OUT/sdk/"; done
podman logs unbrowse-workload > "$OUT/workload.log" 2>&1
"${C[@]}" down -v > /dev/null 2>&1

python3 -I "$HERE/summarise.py" "$OUT/sdk" --known "$KNOWN" --coverage "$OUT/coverage.txt" | tee "$OUT/assertions.txt"
v=$(sed -n 's/^VIOLATIONS=\([0-9]*\).*/\1/p' "$OUT/assertions.txt")
if [ "${v:-1}" = 0 ]; then echo ANTITHESIS_LOCAL_SOAK_PASSED; else
  echo "ANTITHESIS_LOCAL_SOAK_FAILED violations=${v:-?}"
  echo "replay: BUILD=0 $(sed 's/NEMESIS_KINDS=$/ /' "$OUT/run.env") $HERE/soak.sh"
  exit 1
fi
