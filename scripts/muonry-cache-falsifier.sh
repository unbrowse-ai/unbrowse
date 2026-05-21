#!/usr/bin/env bash
# muonry-cache-falsifier.sh
#
# Reproduces (or guards against) the muonry stale-cache bug observed during
# wave-3 + wave-4 corpus expansion (PR #656, PR #657).
#
# Observed: mcp__muonry__read returned an in-process cached snapshot of
# harness/probes/corpus-gate.txt that was 92 lines stale when the on-disk
# file was 180+ lines. Agents had to bypass muonry and read via direct
# disk tools to see the live content.
#
# This falsifier opens a single long-lived muonry daemon (pipe mode),
# writes a 100-line file, reads it, appends 100 lines on disk WITHOUT
# routing the write through muonry, then reads three more times:
#   1. Default flags (no live/fresh)  -> expected stale
#   2. live:true                       -> expected live
#   3. fresh:true                      -> expected live
#
# The script EXITS 0 when behaviour matches the documented contract:
#   - default read returns the stale cached snapshot
#   - live:true and fresh:true return the on-disk content
#
# It EXITS 1 if any of the three asserts fail, with a STALE CACHE or
# UNEXPECTED LIVE READ message. Either branch is informative.
#
# Run from anywhere; uses a temp dir, leaves no debris.
#
# Requires: bash, python3, muonry binary on PATH or at /Users/lekt9/bin/muonry.

set -uo pipefail

MUONRY_BIN="${MUONRY_BIN:-$(command -v muonry || echo /Users/lekt9/bin/muonry)}"

if [[ ! -x "$MUONRY_BIN" ]]; then
  echo "BLOCKED: muonry binary not found at $MUONRY_BIN" >&2
  echo "Set MUONRY_BIN=/path/to/muonry or install muonry." >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "BLOCKED: python3 not on PATH (needed to drive muonry pipe)" >&2
  exit 2
fi

export MUONRY_BIN

python3 - <<'PY'
import json, os, subprocess, sys, tempfile, shutil

muonry_bin = os.environ["MUONRY_BIN"]
tmp = tempfile.mkdtemp(prefix="muonry-falsifier-")
fp = os.path.join(tmp, "corpus.txt")

INITIAL = 100
APPEND = 100
EXPECTED_FINAL = INITIAL + APPEND  # 200

# Write the initial corpus
with open(fp, "w") as f:
    f.writelines(f"line {i}\n" for i in range(1, INITIAL + 1))

# Boot a persistent muonry daemon in pipe mode
proc = subprocess.Popen(
    [muonry_bin],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

def recv():
    # Skip the pipe_ready banner if it shows up
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        try:
            j = json.loads(line)
        except json.JSONDecodeError:
            continue
        if j.get("op") == "pipe_ready":
            continue
        return j

def newline_count(resp):
    if resp is None:
        return -1
    content = resp.get("content", "") or ""
    return content.count("\n")

# READ 1: default flags, primes the cache
send({"tool": "read", "file": fp, "mode": "full"})
r1 = recv()
n1 = newline_count(r1)

# Now concurrently edit the file on disk (this is the wave-N pattern:
# corpus expansion agents append to corpus-gate.txt via direct disk writes
# while muonry's daemon still holds its earlier read cache).
with open(fp, "a") as f:
    f.writelines(f"line {i}\n" for i in range(INITIAL + 1, INITIAL + APPEND + 1))

with open(fp) as f:
    disk_newlines = f.read().count("\n")

assert disk_newlines == EXPECTED_FINAL, (
    f"setup error: disk file has {disk_newlines} newlines, expected {EXPECTED_FINAL}"
)

# READ 2: default flags again. If the bug is live, this is stale.
send({"tool": "read", "file": fp, "mode": "full"})
r2 = recv()
n2 = newline_count(r2)

# READ 3: live=true
send({"tool": "read", "file": fp, "mode": "full", "live": True})
r3 = recv()
n3 = newline_count(r3)

# READ 4: fresh=true
send({"tool": "read", "file": fp, "mode": "full", "fresh": True})
r4 = recv()
n4 = newline_count(r4)

try:
    send({"cmd": "exit"})
    proc.wait(timeout=5)
except Exception:
    proc.kill()

shutil.rmtree(tmp, ignore_errors=True)

# Report — every line is evidence the agent reads in-thread.
print(f"disk_newlines_final={disk_newlines}")
print(f"read1_default_newlines={n1}   (priming read; before append)")
print(f"read2_default_newlines={n2}   (after append, no flags)")
print(f"read3_live_newlines={n3}      (after append, live=true)")
print(f"read4_fresh_newlines={n4}     (after append, fresh=true)")
print()

exit_code = 0
problems = []

# Contract: default read after concurrent disk edit returns stale content.
# (This is the BUG. If muonry ever fixes it, this assert flips and the
# falsifier loudly tells us.)
if n2 >= disk_newlines:
    problems.append(
        f"UNEXPECTED LIVE READ: default-flag read returned {n2} newlines, "
        f"disk has {disk_newlines}. Either muonry now invalidates on stat "
        f"(good, retire the workaround) or the cache window changed."
    )
else:
    print(
        f"CONFIRMED stale-cache on default read: "
        f"returned {n2} newlines vs disk {disk_newlines} "
        f"(gap = {disk_newlines - n2})"
    )

# Contract: live:true MUST return current disk content.
if n3 < disk_newlines:
    problems.append(
        f"STALE CACHE under live=true: muonry returned {n3} newlines, "
        f"disk has {disk_newlines}. The documented bypass is broken."
    )
    exit_code = 1

# Contract: fresh:true MUST return current disk content.
# (fresh:true may add a banner line, so allow >= disk_newlines.)
if n4 < disk_newlines:
    problems.append(
        f"STALE CACHE under fresh=true: muonry returned {n4} newlines, "
        f"disk has {disk_newlines}. The documented bypass is broken."
    )
    exit_code = 1

if problems:
    print()
    for p in problems:
        print(p, file=sys.stderr)
    sys.exit(exit_code if exit_code else 1)

print()
print("OK: stale-cache observed on default read; live=true and fresh=true bypass it.")
sys.exit(0)
PY
