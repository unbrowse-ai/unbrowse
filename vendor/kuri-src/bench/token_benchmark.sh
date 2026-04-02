#!/usr/bin/env bash
# bench/token_benchmark.sh — Reproducible token benchmark
#
# Compares kuri-agent vs agent-browser vs lightpanda on a real page.
# Measures snapshot tokens, action response tokens, and full workflow cost.
#
# Requirements:
#   - Chrome with --remote-debugging-port=9222 (or: kuri-agent open <url>)
#   - kuri-agent built: zig build -Doptimize=ReleaseFast
#   - python3 + tiktoken: pip install tiktoken
#   - (optional) agent-browser: bun install -g agent-browser
#   - (optional) lightpanda at /tmp/lightpanda or $LIGHTPANDA_BIN
#
# Usage:
#   ./bench/token_benchmark.sh [url]

set -euo pipefail

URL="${1:-https://www.google.com/travel/flights?q=Flights%20to%20TPE%20from%20SIN%20on%202026-03-23&curr=SGD}"
AGENT="${KURI_AGENT:-./zig-out/bin/kuri-agent}"
OUT="$(mktemp -d)"
LP="${LIGHTPANDA_BIN:-/tmp/lightpanda}"

echo "=== kuri token benchmark ==="
echo "URL: $URL"
echo ""

# ── Connect ──────────────────────────────────────────────────────────────────
WS=$(curl -s http://127.0.0.1:9222/json 2>/dev/null | python3 -c \
  "import sys,json; tabs=json.load(sys.stdin); print(tabs[0]['webSocketDebuggerUrl'])" 2>/dev/null || true)

if [[ -z "$WS" ]]; then
  echo "ERROR: Chrome not found on port 9222."
  echo "Start with: kuri-agent open $URL"
  exit 1
fi

"$AGENT" use "$WS" >/dev/null 2>&1
"$AGENT" go "$URL" >/dev/null 2>&1
sleep 3

# ── Capture kuri outputs ──────────────────────────────────────────────────────
echo "Capturing kuri-agent..."
"$AGENT" go "$URL"              > "$OUT/kuri_go.txt"     2>&1
sleep 2
"$AGENT" snap                   > "$OUT/kuri_snap.txt"   2>&1
"$AGENT" snap --interactive     > "$OUT/kuri_snap_i.txt" 2>&1
"$AGENT" snap --json            > "$OUT/kuri_json.txt"   2>&1
"$AGENT" snap --text            > "$OUT/kuri_text.txt"   2>&1
"$AGENT" eval "document.title"  > "$OUT/kuri_eval.txt"   2>&1
"$AGENT" text                   > "$OUT/kuri_ptext.txt"  2>&1
"$AGENT" click e0               > "$OUT/kuri_click.txt"  2>&1
"$AGENT" back                   > "$OUT/kuri_back.txt"   2>&1
"$AGENT" scroll                 > "$OUT/kuri_scroll.txt" 2>&1

# ── Capture agent-browser outputs ─────────────────────────────────────────────
if command -v agent-browser &>/dev/null; then
  echo "Capturing agent-browser..."
  agent-browser --cdp 9222 snapshot    > "$OUT/ab_snap.txt"   2>/dev/null || true
  agent-browser --cdp 9222 snapshot -i > "$OUT/ab_snap_i.txt" 2>/dev/null || true
  agent-browser --cdp 9222 evaluate "document.title" > "$OUT/ab_eval.txt" 2>/dev/null || true
  agent-browser --cdp 9222 text        > "$OUT/ab_text.txt"   2>/dev/null || true
fi

# ── Capture lightpanda outputs ────────────────────────────────────────────────
if [[ -x "$LP" ]]; then
  echo "Capturing lightpanda..."
  "$LP" fetch --dump semantic_tree      --http_timeout 15000 "$URL" > "$OUT/lp_tree.txt" 2>/dev/null || true
  "$LP" fetch --dump semantic_tree_text --http_timeout 15000 "$URL" > "$OUT/lp_text.txt" 2>/dev/null || true
fi

# ── Benchmark ─────────────────────────────────────────────────────────────────
echo ""
python3 - "$OUT" << 'PYEOF'
import sys, os, tiktoken, datetime

out = sys.argv[1]
enc = tiktoken.encoding_for_model("gpt-4o")

def t(name):
    p = os.path.join(out, name)
    if not os.path.exists(p) or os.path.getsize(p) == 0: return None, None
    text = open(p).read()
    return os.path.getsize(p), len(enc.encode(text))

def row(label, data, baseline=None, note=""):
    b, tk = data
    if tk is None: return
    ratio = f"{tk/baseline:.1f}x" if baseline and tk != baseline else ("baseline" if baseline else "")
    print(f"  {label:<38} {b:>8,} {tk:>7,} {ratio:>10}  {note}")

print("=" * 90)
print(f"Token Benchmark — {datetime.date.today()}")
print("=" * 90)

# Snapshots
print(f"\n{'SNAPSHOTS':<40} {'Bytes':>8} {'Tokens':>7} {'vs kuri':>10}")
print("─" * 70)
ks = t("kuri_snap.txt")
baseline = ks[1]
row("kuri snap (compact)", ks, baseline)
row("kuri snap --interactive", t("kuri_snap_i.txt"), baseline)
row("kuri snap --json (old default)", t("kuri_json.txt"), baseline)
row("agent-browser snapshot", t("ab_snap.txt"), baseline)
row("agent-browser snapshot -i", t("ab_snap_i.txt"), baseline)
row("lightpanda semantic_tree", t("lp_tree.txt"), baseline, "⚠ no JS")
row("lightpanda semantic_tree_text", t("lp_text.txt"), baseline, "⚠ no JS — empty")

# Actions
print(f"\n{'ACTION RESPONSES':<40} {'Bytes':>8} {'Tokens':>7}")
print("─" * 60)
for label, name in [
    ("kuri go",     "kuri_go.txt"),
    ("kuri click",  "kuri_click.txt"),
    ("kuri back",   "kuri_back.txt"),
    ("kuri scroll", "kuri_scroll.txt"),
    ("kuri eval",   "kuri_eval.txt"),
    ("ab eval",     "ab_eval.txt"),
]:
    b, tk = t(name)
    if tk is not None:
        print(f"  {label:<38} {b:>8,} {tk:>7,}")

# Workflow
print(f"\n{'AGENT WORKFLOW (go→snap→click→snap→eval)':<40} {'Tokens':>7}")
print("─" * 50)
ki = t("kuri_snap_i.txt")[1] or 0
kw = sum(filter(None, [t("kuri_go.txt")[1], ki, t("kuri_click.txt")[1], ki, t("kuri_eval.txt")[1]]))
print(f"  kuri-agent                             {kw:>7,}")

ai = t("ab_snap_i.txt")[1] or 0
if ai:
    aw = sum(filter(None, [10, ai, 10, ai, t("ab_eval.txt")[1] or 10]))
    print(f"  agent-browser                          {aw:>7,}")
    pct = (1 - kw/aw) * 100
    print(f"\n  kuri saves {pct:.0f}% tokens per workflow cycle")

PYEOF
