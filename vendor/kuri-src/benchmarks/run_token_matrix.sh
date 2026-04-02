#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_DIR="$ROOT_DIR/benchmarks"
RESULTS_ROOT="${RESULTS_ROOT:-$ROOT_DIR/.benchmarks/results}"
mkdir -p "$RESULTS_ROOT"

URL="${1:-https://example.com}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SLUG="$(printf '%s' "$URL" | tr '/:?' '_' | tr -s '_' | cut -c1-64)"
OUT_DIR="${RESULTS_DIR:-$RESULTS_ROOT/$STAMP-$SLUG}"
RAW_DIR="$OUT_DIR/raw"
mkdir -p "$RAW_DIR"

KURI_AGENT_BIN="${KURI_AGENT_BIN:-$ROOT_DIR/zig-out/bin/kuri-agent}"
AGENT_BROWSER_BIN="${AGENT_BROWSER_BIN:-$(command -v agent-browser || true)}"
LIGHTPANDA_BIN="${LIGHTPANDA_BIN:-/tmp/lightpanda}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd "$PYTHON_BIN"

if [[ ! -x "$KURI_AGENT_BIN" ]]; then
  echo "missing kuri-agent binary at $KURI_AGENT_BIN" >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import sys
try:
    import tiktoken  # noqa: F401
except Exception as exc:
    print(f"tiktoken unavailable: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY

ensure_chrome() {
  if curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
    return 0
  fi
  "$KURI_AGENT_BIN" open "$URL" >/dev/null 2>&1
  for _ in $(seq 1 50); do
    if curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "Chrome/CDP on 9222 did not come up" >&2
  exit 1
}

ensure_chrome

WS="$(
  json_payload="$(curl -fsS http://127.0.0.1:9222/json)"
  "$PYTHON_BIN" -c 'import json, sys
tabs = json.loads(sys.argv[1])
for tab in tabs:
    ws = tab.get("webSocketDebuggerUrl")
    if ws:
        print(ws)
        break' "$json_payload"
)"

if [[ -z "$WS" ]]; then
  echo "could not discover a websocket debugger URL on port 9222" >&2
  exit 1
fi

"$KURI_AGENT_BIN" use "$WS" >/dev/null 2>&1
"$KURI_AGENT_BIN" go "$URL" >/dev/null 2>&1
sleep 2

capture() {
  local name="$1"
  shift
  "$@" >"$RAW_DIR/$name" 2>&1 || true
}

capture "kuri_go.txt" "$KURI_AGENT_BIN" go "$URL"
sleep 1
capture "kuri_snap.txt" "$KURI_AGENT_BIN" snap
capture "kuri_snap_i.txt" "$KURI_AGENT_BIN" snap --interactive
capture "kuri_json.txt" "$KURI_AGENT_BIN" snap --json
capture "kuri_text_tree.txt" "$KURI_AGENT_BIN" snap --text
capture "kuri_eval.txt" "$KURI_AGENT_BIN" eval "document.title"
capture "kuri_page_text.txt" "$KURI_AGENT_BIN" text
capture "kuri_click.txt" "$KURI_AGENT_BIN" click e0
capture "kuri_back.txt" "$KURI_AGENT_BIN" back
capture "kuri_scroll.txt" "$KURI_AGENT_BIN" scroll

if [[ -n "$AGENT_BROWSER_BIN" ]]; then
  capture "ab_go.txt" "$AGENT_BROWSER_BIN" --cdp 9222 open "$URL"
  capture "ab_snap.txt" "$AGENT_BROWSER_BIN" --cdp 9222 snapshot
  capture "ab_snap_i.txt" "$AGENT_BROWSER_BIN" --cdp 9222 snapshot -i
  capture "ab_eval.txt" "$AGENT_BROWSER_BIN" --cdp 9222 eval "document.title"
  capture "ab_text.txt" "$AGENT_BROWSER_BIN" --cdp 9222 get text
  AB_REF="$(grep -Eo 'ref=e[0-9]+' "$RAW_DIR/ab_snap_i.txt" | head -n 1 | cut -d= -f2 || true)"
  if [[ -n "$AB_REF" ]]; then
    capture "ab_click.txt" "$AGENT_BROWSER_BIN" --cdp 9222 click "@$AB_REF"
  fi
  capture "ab_back.txt" "$AGENT_BROWSER_BIN" --cdp 9222 back
  capture "ab_scroll.txt" "$AGENT_BROWSER_BIN" --cdp 9222 scroll down
fi

if [[ -x "$LIGHTPANDA_BIN" ]]; then
  capture "lp_tree.txt" "$LIGHTPANDA_BIN" fetch --dump semantic_tree --http_timeout 15000 "$URL"
  capture "lp_text.txt" "$LIGHTPANDA_BIN" fetch --dump semantic_tree_text --http_timeout 15000 "$URL"
fi

KURI_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
KURI_BRANCH="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || echo unknown)"
AB_VERSION="$("$AGENT_BROWSER_BIN" --version 2>/dev/null | head -n 1 || true)"
LP_VERSION="$("$LIGHTPANDA_BIN" version 2>/dev/null | head -n 1 || true)"

export OUT_DIR RAW_DIR URL KURI_COMMIT KURI_BRANCH AB_VERSION LP_VERSION
"$PYTHON_BIN" - <<'PY'
import datetime
import json
import os
from pathlib import Path

import tiktoken

out_dir = Path(os.environ["OUT_DIR"])
raw_dir = Path(os.environ["RAW_DIR"])
url = os.environ["URL"]
enc = tiktoken.get_encoding("cl100k_base")

def measure(name):
    p = raw_dir / name
    if not p.exists() or p.stat().st_size == 0:
        return None
    text = p.read_text(errors="replace")
    return {
        "file": name,
        "bytes": p.stat().st_size,
        "tokens": len(enc.encode(text)),
        "text": text,
    }

rows = {
    "kuri snap (compact)": measure("kuri_snap.txt"),
    "kuri snap --interactive": measure("kuri_snap_i.txt"),
    "kuri snap --json": measure("kuri_json.txt"),
    "agent-browser snapshot": measure("ab_snap.txt"),
    "agent-browser snapshot -i": measure("ab_snap_i.txt"),
    "lightpanda semantic_tree": measure("lp_tree.txt"),
    "lightpanda semantic_tree_text": measure("lp_text.txt"),
}

baseline = rows["kuri snap (compact)"]["tokens"] if rows["kuri snap (compact)"] else None

actions = {
    "kuri go": measure("kuri_go.txt"),
    "kuri click": measure("kuri_click.txt"),
    "kuri back": measure("kuri_back.txt"),
    "kuri scroll": measure("kuri_scroll.txt"),
    "kuri eval": measure("kuri_eval.txt"),
    "agent-browser go": measure("ab_go.txt"),
    "agent-browser click": measure("ab_click.txt"),
    "agent-browser back": measure("ab_back.txt"),
    "agent-browser scroll": measure("ab_scroll.txt"),
    "agent-browser eval": measure("ab_eval.txt"),
}

ki = rows["kuri snap --interactive"]["tokens"] if rows["kuri snap --interactive"] else 0
kw = sum(v for v in [
    actions["kuri go"]["tokens"] if actions["kuri go"] else 0,
    ki,
    actions["kuri click"]["tokens"] if actions["kuri click"] else 0,
    ki,
    actions["kuri eval"]["tokens"] if actions["kuri eval"] else 0,
])

ai = rows["agent-browser snapshot -i"]["tokens"] if rows["agent-browser snapshot -i"] else 0
aw = None
if ai and actions["agent-browser go"] and actions["agent-browser click"] and actions["agent-browser eval"]:
    aw = sum(v for v in [
        actions["agent-browser go"]["tokens"],
        ai,
        actions["agent-browser click"]["tokens"],
        ai,
        actions["agent-browser eval"]["tokens"],
    ])

summary = {
    "date": str(datetime.date.today()),
    "url": url,
    "kuri_branch": os.environ.get("KURI_BRANCH", ""),
    "kuri_commit": os.environ.get("KURI_COMMIT", ""),
    "agent_browser_version": os.environ.get("AB_VERSION", ""),
    "lightpanda_version": os.environ.get("LP_VERSION", ""),
    "baseline_tokens": baseline,
    "snapshots": {},
    "actions": {},
    "workflow": {
        "raw": {
            "kuri_agent_tokens": kw,
            "agent_browser_tokens": aw,
            "kuri_savings_pct": round((1 - kw / aw) * 100, 1) if aw else None,
        },
        "normalized_page_state": {
            "kuri_agent_tokens": (ki * 2 + (actions["kuri eval"]["tokens"] if actions["kuri eval"] else 0)) if ki else None,
            "agent_browser_tokens": (ai * 2 + (actions["agent-browser eval"]["tokens"] if actions["agent-browser eval"] else 0)) if ai and actions["agent-browser eval"] else None,
        },
    },
}

normalized_k = summary["workflow"]["normalized_page_state"]["kuri_agent_tokens"]
normalized_a = summary["workflow"]["normalized_page_state"]["agent_browser_tokens"]
summary["workflow"]["normalized_page_state"]["kuri_savings_pct"] = (
    round((1 - normalized_k / normalized_a) * 100, 1)
    if normalized_k is not None and normalized_a
    else None
)

for label, item in rows.items():
    if item:
        summary["snapshots"][label] = {
            "bytes": item["bytes"],
            "tokens": item["tokens"],
            "vs_kuri": round(item["tokens"] / baseline, 3) if baseline else None,
        }
for label, item in actions.items():
    if item:
        summary["actions"][label] = {
            "bytes": item["bytes"],
            "tokens": item["tokens"],
        }

(out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

def fmt_num(v):
    return f"{v:,}" if isinstance(v, int) else v

lines = []
lines.append("# Browser Benchmark")
lines.append("")
lines.append(f"- Date: `{summary['date']}`")
lines.append(f"- URL: `{url}`")
lines.append(f"- Kuri branch: `{summary['kuri_branch']}`")
lines.append(f"- Kuri commit: `{summary['kuri_commit']}`")
if summary["agent_browser_version"]:
    lines.append(f"- agent-browser: `{summary['agent_browser_version']}`")
if summary["lightpanda_version"]:
    lines.append(f"- lightpanda: `{summary['lightpanda_version']}`")
lines.append("")
lines.append("## Snapshot Comparison")
lines.append("")
lines.append("| Tool | Bytes | Tokens | vs kuri | Note |")
lines.append("|---|---:|---:|---:|---|")

notes = {
    "lightpanda semantic_tree": "JS-capable standalone fetch",
    "lightpanda semantic_tree_text": "Text-only semantic dump",
    "kuri snap --json": "Older verbose format",
}

for label in [
    "kuri snap (compact)",
    "kuri snap --interactive",
    "kuri snap --json",
    "agent-browser snapshot",
    "agent-browser snapshot -i",
    "lightpanda semantic_tree",
    "lightpanda semantic_tree_text",
]:
    item = rows.get(label)
    if not item:
        continue
    ratio = "baseline" if label == "kuri snap (compact)" else (f"{item['tokens']/baseline:.1f}x" if baseline else "")
    lines.append(f"| {label} | {fmt_num(item['bytes'])} | {fmt_num(item['tokens'])} | {ratio} | {notes.get(label, '')} |")

lines.append("")
lines.append("## Action Responses")
lines.append("")
lines.append("| Action | Bytes | Tokens |")
lines.append("|---|---:|---:|")
for label in [
    "kuri go",
    "kuri click",
    "kuri back",
    "kuri scroll",
    "kuri eval",
    "agent-browser go",
    "agent-browser click",
    "agent-browser back",
    "agent-browser scroll",
    "agent-browser eval",
]:
    item = actions.get(label)
    if not item:
        continue
    lines.append(f"| {label} | {fmt_num(item['bytes'])} | {fmt_num(item['tokens'])} |")

lines.append("")
lines.append("## Workflow")
lines.append("")
lines.append("### Raw Captured Output")
lines.append("")
lines.append("| Workflow | Tokens |")
lines.append("|---|---:|")
lines.append(f"| kuri-agent `go→snap-i→click→snap-i→eval` | {fmt_num(kw)} |")
if aw is not None:
    lines.append(f"| agent-browser `go→snap-i→click→snap-i→eval` | {fmt_num(aw)} |")
if summary["workflow"]["raw"]["kuri_savings_pct"] is not None:
    lines.append("")
    pct = summary["workflow"]["raw"]["kuri_savings_pct"]
    if pct > 0:
        lines.append(f"Kuri uses about **{pct}% fewer tokens** per raw workflow capture in this run.")
    elif pct < 0:
        lines.append(f"agent-browser uses about **{abs(pct)}% fewer tokens** per raw workflow capture in this run.")
    else:
        lines.append("The two tools landed at effectively the same raw workflow token cost in this run.")

lines.append("")
lines.append("### Normalized Page-State Output")
lines.append("")
lines.append("This strips tool-specific action acknowledgement noise and compares only the state payloads an agent would read back: `snap-i + snap-i + eval`.")
lines.append("")
lines.append("| Workflow | Tokens |")
lines.append("|---|---:|")
lines.append(f"| kuri-agent normalized page-state | {fmt_num(normalized_k) if normalized_k is not None else 'n/a'} |")
lines.append(f"| agent-browser normalized page-state | {fmt_num(normalized_a) if normalized_a is not None else 'n/a'} |")
normalized_pct = summary["workflow"]["normalized_page_state"]["kuri_savings_pct"]
if normalized_pct is not None:
    lines.append("")
    if normalized_pct > 0:
        lines.append(f"Kuri uses about **{normalized_pct}% fewer tokens** for normalized page-state output in this run.")
    elif normalized_pct < 0:
        lines.append(f"agent-browser uses about **{abs(normalized_pct)}% fewer tokens** for normalized page-state output in this run.")
    else:
        lines.append("The two tools landed at effectively the same normalized page-state token cost in this run.")

lines.append("")
lines.append("## Artifacts")
lines.append("")
lines.append("- Raw outputs: [`raw/`](./raw)")
lines.append("- Machine-readable summary: [`summary.json`](./summary.json)")

(out_dir / "summary.md").write_text("\n".join(lines) + "\n")
PY

printf '%s\n' "$OUT_DIR"
