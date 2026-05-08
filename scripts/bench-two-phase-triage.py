#!/usr/bin/env python3
"""bench-two-phase-triage.py — read .bench-history/runs.jsonl rows that
have a `combined_verdict` (two-phase rows) and emit one routing line per
failing URL. Honest: emits UNKNOWN_NEEDS_HUMAN when evidence is silent.

Usage:
  python3 scripts/bench-two-phase-triage.py                 # latest run
  python3 scripts/bench-two-phase-triage.py --run R         # specific run
  python3 scripts/bench-two-phase-triage.py --next          # first actionable
  python3 scripts/bench-two-phase-triage.py --json          # machine-readable
"""
import argparse, json, os, sys
from collections import OrderedDict


def load_rows(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def latest_two_phase_per_url(rows, run_id=None):
    """Keep only rows with combined_verdict (two-phase shape).
    For each URL keep the latest row, optionally filtered by run_id."""
    rows = [r for r in rows if "combined_verdict" in r]
    if run_id:
        rows = [r for r in rows if r.get("run_id") == run_id]
    by_url = OrderedDict()
    for r in rows:
        by_url[r.get("url", "")] = r
    return list(by_url.values())


def latest_two_phase_run_id(rows):
    rids = [r.get("run_id", "") for r in rows if "combined_verdict" in r and r.get("run_id")]
    return max(rids) if rids else ""


def route(row):
    """Pure: row → (route_label, repair_cmd, evidence_oneline) or None for passes."""
    cv = row.get("combined_verdict") or "UNKNOWN"
    url = row.get("url", "")
    p1 = row.get("phase1_status", "")
    p2 = row.get("phase2_status", "")

    if cv == "RE_OK_CALL_OK":
        return None  # genuine pass

    if cv == "VENDOR_BLOCKED":
        bs = row.get("phase1_browser_block_signals", "")
        return (
            "ACCEPT_BLOCK",
            "(no repair — vendor-blocked at browser layer)",
            f"vendor signals: {bs[:80]}",
        )
    if cv == "SOFT_BLOCKED":
        return (
            "ACCEPT_SOFT_BLOCK",
            "(no repair — page rendered <100 bytes; CF/JS challenge)",
            f"text_bytes={row.get('phase1_text_bytes','?')} sparse_capture",
        )

    if cv == "RE_FAILED":
        if p1 == "no_endpoints":
            return (
                "REPAIR_EXTRACTOR",
                f"bash harness/diagnose.sh --url '{url}' --focus extraction",
                f"capture finished but extracted 0 endpoints; filter_rejections={row.get('phase1_filter_rejections','{}')[:120]}",
            )
        if p1 in ("capture_timeout", "capture_error", "capture_parse_error"):
            return (
                "REPAIR_CAPTURE",
                f"unbrowse capture --url '{url}' --intent '{row.get('goal','')}' (verbose run by hand)",
                f"phase1_status={p1} exit={row.get('capture_exit','?')}",
            )
        return (
            "UNKNOWN_NEEDS_HUMAN",
            f"(probe by hand: unbrowse capture --url '{url}' --intent '{row.get('goal','')}')",
            f"combined={cv} p1={p1} p2={p2}",
        )

    if cv == "RE_OK_CALL_FAILED":
        sc = row.get("phase2_status_code", "")
        err = (row.get("phase2_error") or "")[:120]
        # Match invalid_replay_params regardless of phase2_status — the error
        # message is the canonical signal that the captured url_template needs
        # runtime-supplied params (q, type, id, …) the agent must inject.
        if "invalid_replay_params" in err or "missing_required_param" in err:
            return (
                "REPAIR_REPLAY_PARAMS",
                f"unbrowse execute --skill {row.get('phase1_skill_id','?')} --endpoint {row.get('phase1_endpoint_id','?')} -p key=value  # supply params",
                f"replay needs params (likely from url_template {{...}}); err={err}",
            )
        if p2 == "http_4xx":
            return (
                "REPAIR_REPLAY_4XX",
                f"unbrowse skill {row.get('phase1_skill_id','?')}  # inspect captured params/headers",
                f"sc={sc} err={err}",
            )
        if p2 == "http_5xx":
            return (
                "REPAIR_REPLAY_5XX",
                f"unbrowse skill {row.get('phase1_skill_id','?')}  # server-side; may be transient",
                f"sc={sc} err={err}",
            )
        if p2 == "network_error":
            return (
                "REPAIR_REPLAY_NETWORK",
                "(libcurl-impersonate fetch broke; check ZlibError or CORS)",
                f"err={err}",
            )
        if p2 == "timeout":
            return (
                "REPAIR_REPLAY_TIMEOUT",
                "(replay took >timeout; check if endpoint requires session cookies)",
                f"err={err}",
            )
        return (
            "UNKNOWN_NEEDS_HUMAN",
            f"(probe by hand: unbrowse execute --skill {row.get('phase1_skill_id','?')} --endpoint {row.get('phase1_endpoint_id','?')})",
            f"p2={p2} sc={sc} err={err}",
        )

    return (
        "UNKNOWN_NEEDS_HUMAN",
        f"(probe by hand: unbrowse capture --url '{url}' --intent '{row.get('goal','')}')",
        f"combined={cv} p1={p1} p2={p2}",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default=".bench-history/runs.jsonl")
    ap.add_argument("--run", default=None, help="restrict to run_id; default = latest two-phase run")
    ap.add_argument("--next", dest="next_only", action="store_true", help="emit only the first actionable failing row")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.history):
        print(f"[2p-triage] no history at {args.history}", file=sys.stderr)
        sys.exit(0)

    all_rows = load_rows(args.history)
    if not all_rows:
        print("[2p-triage] history is empty", file=sys.stderr)
        sys.exit(0)

    target_run = args.run or latest_two_phase_run_id(all_rows)
    if not target_run:
        print("[2p-triage] no two-phase rows in history (no combined_verdict found)", file=sys.stderr)
        sys.exit(0)

    rows = latest_two_phase_per_url(all_rows, run_id=target_run)
    if not rows:
        print(f"[2p-triage] no rows in run {target_run}", file=sys.stderr)
        sys.exit(0)

    failing = []
    for r in rows:
        result = route(r)
        if result is None:
            continue
        label, repair, ev = result
        failing.append({
            "url": r.get("url", ""),
            "goal": r.get("goal", ""),
            "combined_verdict": r.get("combined_verdict"),
            "phase1_status": r.get("phase1_status"),
            "phase2_status": r.get("phase2_status"),
            "route": label,
            "repair_cmd": repair,
            "evidence": ev,
        })

    if args.next_only and failing:
        actionable = [f for f in failing if not f["route"].startswith("ACCEPT_")]
        failing = [actionable[0]] if actionable else failing[:1]

    if args.json:
        print(json.dumps({"run_id": target_run, "failing": failing, "count": len(failing)}, indent=2))
        return

    print(f"[2p-triage] run={target_run} failing={len(failing)}")
    for f in failing:
        print(f"\n  {f['combined_verdict']:<22} {f['url']}")
        print(f"    p1={f['phase1_status']:<22} p2={f['phase2_status']}")
        print(f"    route:      {f['route']}")
        print(f"    evidence:   {f['evidence']}")
        print(f"    repair_cmd: {f['repair_cmd']}")


if __name__ == "__main__":
    main()
