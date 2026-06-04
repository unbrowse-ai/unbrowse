#!/usr/bin/env python3
"""layer3_train.py — fit the learned contrastive energy head on the execution
ledger and ship it as a content-addressed pointer.

The ledger IS the training set: positives = success rows, negatives =
failure/fallback rows. We fit a logistic energy head on a TRAIN split, then on a
held-out TEST split compare its ranking AUC to the train-free back-off baseline
(layer 1). The learned head wins because it generalises across features (source
reliability, domain priors, query n-grams) to cells the back-off statistic is too
cold to rank.

Ships: bench/ebm/energy-head.<sha8>.json  (the fitted weights, content-addressed)
       bench/ebm/energy-head.latest.json  (the pointer consumers read; rollout =
                                            this pointer changing — cache invalidation)

usage: python3 scripts/ebm/layer3_train.py [--real] [--quiet]
exit 0 iff the learned head beats the baseline on held-out (lift >= MIN_LIFT).
"""
import hashlib, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_ebm import (synth_ledger, load_real_ledger, fit_backoff, backoff_energy,
                        train_head, head_score, auc)

REPO = Path(__file__).resolve().parent.parent.parent
OUT = REPO / "bench" / "ebm"
MIN_LIFT = 0.03
MIN_LEDGER_FOR_REAL = 200

def split(rows, frac=0.7, seed=7):
    import random
    rng = random.Random(seed); rows = rows[:]; rng.shuffle(rows)
    k = int(len(rows) * frac)
    return rows[:k], rows[k:]

def main():
    use_real = "--real" in sys.argv
    quiet = "--quiet" in sys.argv
    real = load_real_ledger() if use_real else []
    if len(real) >= MIN_LEDGER_FOR_REAL:
        rows, src, synthetic = real, f"real ledger ({len(real)} rows)", False
    else:
        rows, _ = synth_ledger()
        src = f"synthetic ledger ({len(rows)} rows)" + (f"; real had only {len(real)}" if use_real else "")
        synthetic = True
    train, test = split(rows)

    base = fit_backoff(train)
    w = train_head(train)

    labels = [1 if r["outcome"] == "success" else 0 for r in test]
    base_scores = [backoff_energy(base, r["domain"], r["endpoint_id"], r["source"]) for r in test]
    head_scores = [head_score(w, r["domain"], r["endpoint_id"], r["source"], r.get("intent", "")) for r in test]
    auc_base, auc_head = auc(base_scores, labels), auc(head_scores, labels)
    lift = auc_head - auc_base

    # cold-cell subset: where back-off has no opinion (NEUTRAL 0.5) — generalisation test
    cold = [(h, y) for h, b, y in zip(head_scores, base_scores, labels) if abs(b - 0.5) < 1e-9]
    auc_cold = auc([h for h, _ in cold], [y for _, y in cold]) if cold else None

    OUT.mkdir(parents=True, exist_ok=True)
    model = {"dim": len(w), "weights": w, "trained_on": src, "synthetic": synthetic, "metric": {
        "auc_baseline": round(auc_base, 4), "auc_learned": round(auc_head, 4),
        "lift": round(lift, 4), "auc_cold_cells": round(auc_cold, 4) if auc_cold is not None else None,
        "n_train": len(train), "n_test": len(test)}}
    blob = json.dumps(model, sort_keys=True)
    sha = hashlib.sha256(blob.encode()).hexdigest()[:8]
    art = OUT / f"energy-head.{sha}.json"
    art.write_text(blob)
    # The LIVE pointer the production ranker reads (energy-head.latest.json) only ever
    # carries a REAL-ledger head. A synthetic head (the witness) ships to a separate
    # pointer so it can never pollute real-domain ranking — the ranker reads `.latest`.
    pointer_name = "energy-head.latest.json" if not synthetic else "energy-head.synthetic.json"
    (OUT / pointer_name).write_text(json.dumps({
        "pointer": f"energy-head.{sha}.json", "sha256_8": sha, "synthetic": synthetic,
        "auc_baseline": round(auc_base, 4), "auc_learned": round(auc_head, 4), "lift": round(lift, 4),
        "trained_on": src}, indent=2) + "\n")

    if not quiet:
        print(f"[layer3] trained on {src}")
        print(f"[layer3] held-out AUC: baseline(back-off)={auc_base:.3f}  learned={auc_head:.3f}  lift={lift:+.3f}")
        if auc_cold is not None:
            print(f"[layer3] cold-cell AUC (back-off blind here): learned={auc_cold:.3f}")
        print(f"[layer3] shipped pointer energy-head.{sha}.json -> energy-head.latest.json")
    sys.exit(0 if lift >= MIN_LIFT and auc_head > 0.5 else 1)

if __name__ == "__main__":
    main()
