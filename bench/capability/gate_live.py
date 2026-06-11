#!/usr/bin/env python3
"""Live gate (Day-6 dominion) — the end-to-end source=live spine for execution axes.

Full caller path: capture (×2 independent) → score each → two-witness verdict → record a
source=live row in history.jsonl → exit 0/1.

This is the GENUINE two-witness the auditor demanded: TWO independent `go` captures of the
same URL (not one frozen file read twice). Liveness is proven by the captures themselves
(real session IDs + real byte counts), so it does NOT need the eval-version string that this
binary leaves empty. A run only stamps source=live when both captures actually returned data.

Usage:
  python3 bench/capability/gate_live.py --url <URL> --gold-id <id> --gold <axisB_live.jsonl>
          [--min-score 0.9] [--agree-tol 0.15] [--min-bytes 500]
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, f"{name}.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


lp = _load("live_protocol")
se = _load("score_execute")


def _load_gold(path, gid):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and json.loads(line).get("id") == gid:
                return json.loads(line)
    raise KeyError(f"gold id {gid} not in {path}")


def _content_key(data):
    """A stable, content-sensitive key for cross-witness agreement: the subreddit of the
    first child of a Reddit listing. Two witnesses must agree on THIS, not on the
    (content-blind) structural score. None when the payload isn't the expected shape."""
    try:
        obj = json.loads(data) if isinstance(data, str) else data
        return obj["data"]["children"][0]["data"]["subreddit"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        return None


def capture_and_score(url, gold, gid, min_bytes):
    """One witness: live go → score. Returns (witness_dict, liveness_ok)."""
    r = lp.go(url, timeout=120)
    data = r.get("page_text") or ""
    live_ok = bool(r.get("ok")) and len(data) >= min_bytes
    sc = se.score_record({"id": gid, "data": data}, gold)
    return {
        "session_id": r.get("session_id"),
        "data_bytes": len(data),
        "score": sc["score"],
        "parts": sc["parts"],
        "content_key": _content_key(data),
        "live_ok": live_ok,
    }, live_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--gold-id", required=True)
    ap.add_argument("--gold", default=os.path.join(HERE, "gold/axisB_live.jsonl"))
    ap.add_argument("--min-score", type=float, default=0.9)
    ap.add_argument("--agree-tol", type=float, default=0.15)  # live content shifts; structure is stable
    ap.add_argument("--min-bytes", type=int, default=500)
    ap.add_argument("--expect", default=None,
                    help="expected content_key (e.g. subreddit) BOTH witnesses must return — binds the score to the RIGHT resource")
    ap.add_argument("--ts", default="", help="RFC3339 stamp (caller-provided; no clock in-script)")
    args = ap.parse_args()

    gold = _load_gold(args.gold, args.gold_id)

    w1, live1 = capture_and_score(args.url, gold, args.gold_id, args.min_bytes)
    w2, live2 = capture_and_score(args.url, gold, args.gold_id, args.min_bytes)

    # liveness: both captures returned real data AND came from DISTINCT sessions (genuine
    # independence — two reads of one attached session is NOT two witnesses).
    liveness = bool(live1 and live2 and w1["session_id"] and w2["session_id"]
                    and w1["session_id"] != w2["session_id"])
    s1, s2 = w1["score"], w2["score"]
    score_ok = s1 >= args.min_score and s2 >= args.min_score
    # agreement is CONTENT-sensitive (the structural score is content-blind): both witnesses
    # must return the same content_key, and it must match --expect when given. This is what
    # stops two DIFFERENT wrong pages from both scoring 1.0 and "agreeing".
    k1, k2 = w1["content_key"], w2["content_key"]
    content_agree = (k1 is not None and k1 == k2)
    expect_ok = (args.expect is None) or (k1 == args.expect)
    gate = bool(liveness and score_ok and content_agree and expect_ok)
    # source label is DERIVED from evidence — a no-capture run does not wear the live badge.
    source = "live" if (live1 or live2) else "live-nocapture"

    row = {
        "ts": args.ts, "source": source, "axis": "B_execute", "url": args.url,
        "gold_id": args.gold_id, "score": s1, "content_key": k1, "expect": args.expect,
        "thresholds": {"min_score": args.min_score, "agree_tol": args.agree_tol, "min_bytes": args.min_bytes},
        "witnesses": [w1, w2], "liveness": liveness,
        "content_agree": content_agree, "expect_ok": expect_ok, "gate": "true" if gate else "false",
    }
    with open(os.path.join(HERE, "history.jsonl"), "a") as f:
        f.write(json.dumps(row) + "\n")

    print("── live gate (Axis B execution) ───────────────────")
    print(f" url={args.url}  expect_key={args.expect}")
    print(f" witness1: session={w1['session_id']} bytes={w1['data_bytes']} score={s1} key={k1} live_ok={live1}")
    print(f" witness2: session={w2['session_id']} bytes={w2['data_bytes']} score={s2} key={k2} live_ok={live2}")
    print(f" liveness(distinct real captures)={liveness}  content_agree={content_agree}  expect_ok={expect_ok}")
    print(f" GATE: {row['gate']}  (source={source})")
    print("───────────────────────────────────────────────────")
    return 0 if gate else 1


if __name__ == "__main__":
    raise SystemExit(main())
