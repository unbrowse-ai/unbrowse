#!/usr/bin/env python3
"""
auto-corpus-feeder.py — propose bench-gate corpus rows from real intent failures.

Reads GET /v1/telemetry/recent-failures (admin-gated) and surfaces failed
intents that look like good benchmark probes. NEVER auto-merges into
harness/probes/corpus-gate.txt. Writes a proposed-probes diff that the agent
reads in-thread and cherry-picks via PR.

Substrate-faithful: this script COLLECTS evidence (which intent+url pairs
recur, with what frequency). It does NOT classify which are real bugs vs
out-of-scope. The agent judges from the diff and the per-row evidence in
.bench-gate/proposed-probes-<ts>.evidence.jsonl.

Usage:
  UNBROWSE_ADMIN_KEY=...  ./auto-corpus-feeder.py [--since 2026-05-13T00:00:00Z]
                                                  [--min-count 2]
                                                  [--limit 500]
                                                  [--api https://beta-api.unbrowse.ai]
                                                  [--dry-run]

Output:
  .bench-gate/proposed-probes-<utc>.txt        — candidate `intent|url` rows
  .bench-gate/proposed-probes-<utc>.evidence.jsonl  — per-candidate raw rows
  .bench-gate/proposed-probes-<utc>.diff       — diff vs current corpus-gate.txt
"""
from __future__ import annotations

import argparse
import collections
import datetime as _dt
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS = REPO_ROOT / "harness" / "probes" / "corpus-gate.txt"
OUT_DIR = REPO_ROOT / ".bench-gate"


def fetch_recent_failures(api: str, admin_key: str, since: str, limit: int) -> list[dict]:
    qs = urllib.parse.urlencode({"since": since, "limit": str(limit)})
    url = f"{api.rstrip('/')}/v1/telemetry/recent-failures?{qs}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {admin_key}",
            "User-Agent": "auto-corpus-feeder/1.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sys.stderr.write(f"[feeder] HTTP {e.code}: {body[:500]}\n")
        sys.exit(2)
    return list(payload.get("failures", []))


def load_existing_corpus() -> set[str]:
    if not CORPUS.exists():
        return set()
    rows = set()
    for line in CORPUS.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.add(line)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None, help="ISO-8601 lower bound (default: 7d ago)")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--min-count", type=int, default=2,
                        help="Minimum recurrence count to propose a probe")
    parser.add_argument("--api", default=os.environ.get("UNBROWSE_API", "https://beta-api.unbrowse.ai"))
    parser.add_argument("--dry-run", action="store_true",
                        help="Print to stdout instead of writing files")
    args = parser.parse_args()

    admin_key = os.environ.get("UNBROWSE_ADMIN_KEY", "")
    if not admin_key:
        sys.stderr.write("[feeder] UNBROWSE_ADMIN_KEY env var required\n")
        sys.exit(2)

    since = args.since or (
        _dt.datetime.now(_dt.UTC) - _dt.timedelta(days=7)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    failures = fetch_recent_failures(args.api, admin_key, since, args.limit)
    if not failures:
        sys.stderr.write(f"[feeder] no failures in window since={since}\n")
        sys.exit(0)

    # Group by (intent_normalized, host) and count
    def host_of(u: str | None) -> str:
        if not u:
            return ""
        try:
            return urllib.parse.urlparse(u).hostname or ""
        except Exception:
            return ""

    def norm_intent(i: str | None) -> str:
        if not i:
            return ""
        return " ".join(i.strip().lower().split())

    groups: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
    for f in failures:
        intent = norm_intent(f.get("intent"))
        host = host_of(f.get("url"))
        if not intent or not host:
            continue
        groups[(intent, host)].append(f)

    # Filter by min-count
    candidates = [
        (key, rows)
        for key, rows in groups.items()
        if len(rows) >= args.min_count
    ]
    candidates.sort(key=lambda kv: -len(kv[1]))

    existing = load_existing_corpus()

    ts = _dt.datetime.now(_dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    proposed_rows: list[str] = []
    evidence_rows: list[dict] = []
    skipped_existing = 0
    for (intent, host), rows in candidates:
        first = rows[0]
        url = first.get("url") or ""
        if not url:
            continue
        line = f"{intent}|{url}"
        if line in existing:
            skipped_existing += 1
            continue
        proposed_rows.append(line)
        evidence_rows.append({
            "candidate_line": line,
            "intent": intent,
            "url": url,
            "host": host,
            "count_in_window": len(rows),
            "first_seen": min(r.get("received_at", "") for r in rows),
            "last_seen": max(r.get("received_at", "") for r in rows),
            "error_classes": sorted({r.get("error_class") or "unknown" for r in rows}),
            "last_tools": sorted({r.get("last_tool") or "unknown" for r in rows}),
            "platforms": sorted({r.get("platform") or "unknown" for r in rows}),
            "mcp_versions": sorted({r.get("mcp_version") or "unknown" for r in rows}),
            "session_ids_head": [r.get("session_id") for r in rows[:5]],
        })

    summary = {
        "ts": ts,
        "since": since,
        "limit": args.limit,
        "min_count": args.min_count,
        "raw_failures_returned": len(failures),
        "unique_intent_host_pairs": len(groups),
        "candidates_above_min_count": len(candidates),
        "candidates_already_in_corpus": skipped_existing,
        "candidates_proposed_new": len(proposed_rows),
        "existing_corpus_size": len(existing),
    }

    if args.dry_run:
        print(json.dumps(summary, indent=2))
        for row in proposed_rows:
            print(row)
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    txt_path = OUT_DIR / f"proposed-probes-{ts}.txt"
    ev_path = OUT_DIR / f"proposed-probes-{ts}.evidence.jsonl"
    diff_path = OUT_DIR / f"proposed-probes-{ts}.diff"

    txt_path.write_text("\n".join(proposed_rows) + ("\n" if proposed_rows else ""))
    with ev_path.open("w") as f:
        for row in evidence_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # Synthesise a diff by appending the proposed rows to a copy of the
    # current corpus and diffing.
    if proposed_rows:
        merged = OUT_DIR / f"proposed-probes-{ts}.merged.txt"
        existing_text = CORPUS.read_text() if CORPUS.exists() else ""
        if existing_text and not existing_text.endswith("\n"):
            existing_text += "\n"
        merged.write_text(existing_text + "# === proposed by auto-corpus-feeder " + ts + " ===\n" + "\n".join(proposed_rows) + "\n")
        diff_proc = subprocess.run(
            ["diff", "-u", str(CORPUS), str(merged)],
            capture_output=True, text=True
        )
        diff_path.write_text(diff_proc.stdout)
        merged.unlink()

    summary["proposed_path"] = str(txt_path.relative_to(REPO_ROOT))
    summary["evidence_path"] = str(ev_path.relative_to(REPO_ROOT))
    summary["diff_path"] = str(diff_path.relative_to(REPO_ROOT)) if proposed_rows else None
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
