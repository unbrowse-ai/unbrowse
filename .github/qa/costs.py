#!/usr/bin/env python3
"""What a Claude Code run cost, read from its own record (UNB-235: measure the first week of agent QA on every push).

A record is the CLI's `--output-format stream-json` lines, or claude-code-action's execution file (a JSON array of the
same events). Its `result` event carries what the CLI counted: `total_cost_usd`, `num_turns`, `duration_ms` and
`usage` (input, output, cache write, cache read tokens). On a subscription token the dollar figure is what the same
tokens would cost on the API, not a charge; the tokens are the measure.

    python3 .github/qa/costs.py --label "Agent QA" record.json [more records ...] [--json out.json]

Prints a markdown table, one row per record and a total. A record with no result event is a row that says so.
"""
import argparse
import json
import sys
from pathlib import Path

TOKENS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def events(text):
    text = text.strip()
    if text.startswith("["):
        try:
            data = json.loads(text)
            return [e for e in data if isinstance(e, dict)]
        except ValueError:
            pass
    out = []
    for line in text.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict):
            out.append(e)
    return out


def cost_of(text):
    """The last result event's figures, or None when the run never reached one."""
    results = [e for e in events(text) if e.get("type") == "result"]
    if not results:
        return None
    r = results[-1]
    usage = r.get("usage") or {}
    return {
        "usd": float(r.get("total_cost_usd") or 0),
        "turns": int(r.get("num_turns") or 0),
        "seconds": round((r.get("duration_ms") or 0) / 1000, 1),
        "is_error": bool(r.get("is_error")),
        **{k: int(usage.get(k) or 0) for k in TOKENS},
    }


def table(label, rows):
    out = [f"#### Cost: {label}", "", "| Run | Turns | Seconds | Input | Output | Cache write | Cache read | USD (API price) |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    total = {k: 0 for k in ("turns", "seconds", "usd", *TOKENS)}
    for name, c in rows:
        if c is None:
            out.append(f"| {name} | no result: the run ended before the CLI counted it | | | | | | |")
            continue
        for k in total:
            total[k] += c[k]
        flag = " (ended in an error)" if c["is_error"] else ""
        out.append(f"| {name}{flag} | {c['turns']} | {c['seconds']} | {c['input_tokens']} | {c['output_tokens']} | {c['cache_creation_input_tokens']} | {c['cache_read_input_tokens']} | {c['usd']:.4f} |")
    out.append(f"| **total** | {total['turns']} | {round(total['seconds'], 1)} | {total['input_tokens']} | {total['output_tokens']} | {total['cache_creation_input_tokens']} | {total['cache_read_input_tokens']} | {total['usd']:.4f} |")
    return "\n".join(out) + "\n", total


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", required=True)
    parser.add_argument("--json", type=Path)
    parser.add_argument("records", nargs="*", type=Path)
    args = parser.parse_args(argv)
    rows = [(p.stem, cost_of(p.read_text(errors="replace")) if p.exists() else None) for p in args.records]
    md, total = table(args.label, rows)
    if args.json:
        args.json.write_text(json.dumps({"label": args.label, "runs": dict(rows), "total": total}, indent=2) + "\n")
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
