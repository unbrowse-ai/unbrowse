#!/usr/bin/env python3
"""Axis A — action-retrieval / indexing-coverage scorer (deterministic).

Grades `unbrowse eval resolve` output against gold qrels, cloning ToolRet's
metric set (nDCG@10, Recall@10) plus a BFCL-style abstention check.

No model call, no network, no grep-classification of unstructured text — pure
functions over data shapes (the ARCHITECTURE.md "deterministic scoring" seam).

Inputs (all jsonl):
  --corpus   {id, tier, intent, url, auth, axis}            (the queries)
  --qrels    {id, relevant:[endpoint_id,...]}               (gold; absent/empty => unanswerable)
  --results  {id, shortlist:[endpoint_id | {endpoint_id}]}  (resolve output, one row per id)
Output: JSON summary to stdout. Exit 1 under --gate if below --min-ndcg.

Definitions:
  answerable query   = has >=1 gold relevant endpoint.
  unanswerable query = gold relevant is empty/absent (system should abstain = empty shortlist).
  nDCG@k, Recall@k   = computed over answerable queries only.
  abstention_acc     = fraction of unanswerable queries where shortlist is empty.
  coverage@k         = fraction of answerable queries with >=1 relevant in top-k (hit-rate).
"""
import argparse
import json
import math
import sys


def load_jsonl(path):
    rows = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            rows[obj["id"]] = obj
    return rows


def shortlist_ids(row):
    """Accept shortlist of bare ids or of {endpoint_id} objects."""
    out = []
    for item in row.get("shortlist", []) or []:
        if isinstance(item, dict):
            eid = item.get("endpoint_id") or item.get("id")
        else:
            eid = item
        if eid is not None and eid != "":
            out.append(str(eid))  # coerce: int/str ids must compare equal to str gold
    return out


def dcg(rels):
    return sum((2 ** r - 1) / math.log2(i + 2) for i, r in enumerate(rels))


def _dedup(seq):
    """Distinct ids in first-occurrence order. A shortlist is a ranked SET of
    endpoints; a duplicate must not earn credit twice (degenerate-input guard —
    a retrieval system returning the same endpoint twice gains nothing)."""
    seen, out = set(), []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def ndcg_at_k(ranked_ids, relevant_set, k):
    ranked_ids = _dedup(ranked_ids)
    gains = [1 if eid in relevant_set else 0 for eid in ranked_ids[:k]]
    ideal = sorted([1] * min(len(relevant_set), k) + [0] * k, reverse=True)[:k]
    idcg = dcg(ideal)
    return (dcg(gains) / idcg) if idcg > 0 else 0.0


def recall_at_k(ranked_ids, relevant_set, k):
    if not relevant_set:
        return 0.0
    ranked_ids = _dedup(ranked_ids)
    hit = sum(1 for eid in ranked_ids[:k] if eid in relevant_set)
    return hit / len(relevant_set)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--qrels", required=True)
    ap.add_argument("--results", required=True)
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--min-ndcg", type=float, default=None, help="gate threshold")
    ap.add_argument("--gate", action="store_true")
    args = ap.parse_args(argv)

    corpus = load_jsonl(args.corpus)
    qrels = load_jsonl(args.qrels)
    results = load_jsonl(args.results)

    per_query = []
    ndcgs, recalls, covers, abstain = [], [], [], []
    for qid in corpus:
        relevant = set(str(r) for r in ((qrels.get(qid) or {}).get("relevant", []) or []))
        ranked = shortlist_ids(results.get(qid, {}))
        if relevant:  # answerable
            nd = ndcg_at_k(ranked, relevant, args.k)
            rc = recall_at_k(ranked, relevant, args.k)
            cov = 1.0 if any(e in relevant for e in ranked[: args.k]) else 0.0
            ndcgs.append(nd)
            recalls.append(rc)
            covers.append(cov)
            per_query.append({"id": qid, "answerable": True, "ndcg": round(nd, 4),
                              "recall": round(rc, 4), "covered": cov})
        else:  # unanswerable -> should abstain (empty shortlist)
            correct = 1.0 if not ranked else 0.0
            abstain.append(correct)
            per_query.append({"id": qid, "answerable": False, "abstained": bool(correct)})

    def mean(xs):
        return round(sum(xs) / len(xs), 4) if xs else None

    summary = {
        "axis": "A_retrieval",
        "k": args.k,
        "n_answerable": len(ndcgs),
        "n_unanswerable": len(abstain),
        f"ndcg@{args.k}": mean(ndcgs),
        f"recall@{args.k}": mean(recalls),
        f"coverage@{args.k}": mean(covers),
        "abstention_acc": mean(abstain),
        "per_query": per_query,
    }
    print(json.dumps(summary, indent=2))

    if args.gate:
        nd = summary[f"ndcg@{args.k}"] or 0.0
        if args.min_ndcg is not None and nd < args.min_ndcg:
            print(f"GATE FAIL: ndcg@{args.k}={nd} < {args.min_ndcg}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
