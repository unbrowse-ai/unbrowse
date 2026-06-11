#!/usr/bin/env python3
"""Axis B/C — execution scorer (deterministic).

Grades the data an `execute`/`go` actually returned against a gold contract. Because
LIVE content changes minute-to-minute, gold is INVARIANT-based (schema/field/value
constraints) plus optional token-F1 / ROUGE-L overlap for prose — cloning AssistantBench
(token-F1, JSON key-value) and the bench/exa ROUGE-L extraction metric.

Pure functions over data shapes — no model call, no grep-classification.

Result record (jsonl): {id, intent, data}            # data = raw payload string from go/execute
Gold record (jsonl):   {id, field_checks:[...], answer_text?, weights?}
  field_check = {path, op, value?}  op in: exists | equals | min_count | all_nonempty | contains
  path syntax: dot keys + [N] index + [] (all elements) e.g. data.children[].data.title
Score = mean of (field_score, token_f1?, rouge_l?) over whichever golds are present.
An unparseable/HTML payload scores 0 on field_checks (execution did NOT return real data).
"""
import argparse
import json
import math
import sys
from collections import Counter


# ---- text metrics (AssistantBench token-F1, Exa ROUGE-L) ----
def token_f1(pred, gold):
    p, g = pred.lower().split(), gold.lower().split()
    if not p or not g:
        return 0.0
    overlap = sum((Counter(p) & Counter(g)).values())
    if overlap == 0:
        return 0.0
    prec, rec = overlap / len(p), overlap / len(g)
    return 2 * prec * rec / (prec + rec)


def _lcs_len(a, b):
    dp = [0] * (len(b) + 1)
    for x in a:
        prev = 0
        for j, y in enumerate(b, 1):
            prev, dp[j] = dp[j], (prev + 1 if x == y else max(dp[j], dp[j - 1]))
    return dp[len(b)]


def rouge_l(pred, gold):
    p, g = pred.split(), gold.split()
    if not p or not g:
        return 0.0
    l = _lcs_len(p, g)
    if l == 0:
        return 0.0
    prec, rec = l / len(p), l / len(g)
    return 2 * prec * rec / (prec + rec)


# ---- json path + field checks ----
def _split_path(path):
    out = []
    for seg in path.split("."):
        while "[" in seg:
            key, rest = seg.split("[", 1)
            if key:
                out.append(key)
            idx, seg = rest.split("]", 1)
            out.append("[]" if idx == "" else int(idx))
        if seg:
            out.append(seg)
    return out


def _resolve_all(obj, parts):
    """Resolve a path that may contain one '[]' (all elements). Returns scalar or list."""
    cur = obj
    for i, part in enumerate(parts):
        if part == "[]":
            if not isinstance(cur, list):
                raise TypeError("[] on non-list")
            tail = parts[i + 1:]
            return [_resolve_all(e, tail) for e in cur]
        cur = cur[part]
    return cur


def check_field(data_obj, check):
    path, op = check["path"], check["op"]
    try:
        val = _resolve_all(data_obj, _split_path(path))
    except (KeyError, IndexError, TypeError):
        return False
    if op == "exists":
        return val is not None and val != []  # an empty []-resolved list is NOT present data
    if op == "equals":
        return val == check["value"]
    if op == "min_count":
        return isinstance(val, list) and len(val) >= check["value"]
    if op == "all_nonempty":
        items = val if isinstance(val, list) else [val]
        return len(items) > 0 and all(bool(x) for x in items)
    if op == "contains":
        return isinstance(val, str) and check["value"] in val  # only real string leaves, not serialized JSON
    return False


def score_record(result, gold):
    data_raw = result.get("data") or ""
    parts, weights = [], []
    checks = gold.get("field_checks") or []
    # Parse once. When field_checks are requested, an UNPARSEABLE payload (HTML wall,
    # truncated, error blob) scores 0 on EVERYTHING — execution did not return structured
    # data, so token overlap must not leak a nonzero score (MED-5 fix).
    parsed, parse_ok = None, True
    if isinstance(data_raw, str):
        try:
            parsed = json.loads(data_raw)
        except json.JSONDecodeError:
            parse_ok = False
    else:
        parsed = data_raw
    if checks:
        if parse_ok and parsed is not None:
            field_score = sum(check_field(parsed, c) for c in checks) / len(checks)
        else:
            field_score = 0.0
        parts.append(("field", field_score))
        weights.append(gold.get("weights", {}).get("field", 1.0))
    if gold.get("answer_text") and (not checks or parse_ok):
        txt = data_raw if isinstance(data_raw, str) else json.dumps(data_raw)
        parts.append(("token_f1", token_f1(txt, gold["answer_text"])))
        weights.append(gold.get("weights", {}).get("token_f1", 1.0))
        parts.append(("rouge_l", rouge_l(txt, gold["answer_text"])))
        weights.append(gold.get("weights", {}).get("rouge_l", 1.0))
    if not parts:
        return {"id": result.get("id"), "score": 0.0, "parts": {}, "note": "no gold"}
    total_w = sum(weights)
    if total_w == 0:  # misconfigured all-zero weights — fall back to unweighted mean
        total_w, weights = len(parts), [1.0] * len(parts)
    score = sum(s * w for (_, s), w in zip(parts, weights)) / total_w
    return {"id": result.get("id"), "score": round(score, 4), "parts": {k: round(v, 4) for k, v in parts}}


def _load(path):
    rows = {}
    with open(path) as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                print(f"warn: {path}:{n} malformed jsonl, skipped", file=sys.stderr)
                continue
            rows[o["id"]] = o
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--min-score", type=float, default=None)
    ap.add_argument("--gate", action="store_true")
    args = ap.parse_args(argv)
    results, gold = _load(args.results), _load(args.gold)
    per, scores = [], []
    for rid, r in results.items():
        g = gold.get(rid)
        if not g:
            continue
        sc = score_record(r, g)
        per.append(sc)
        scores.append(sc["score"])
    mean = round(sum(scores) / len(scores), 4) if scores else None
    print(json.dumps({"axis": "B_execute", "n": len(scores), "mean_score": mean, "per": per}, indent=2))
    if args.gate and args.min_score is not None and (mean or 0.0) < args.min_score:
        print(f"GATE FAIL: {mean} < {args.min_score}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
