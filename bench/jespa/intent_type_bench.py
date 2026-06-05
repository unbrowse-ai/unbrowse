#!/usr/bin/env python3
"""intent_type_bench.py — a NEW real-data unbrowse benchmark: classify a route's ACCESS-PATTERN
type (anchor / ssr-list / graphql / auth-gated / semantic-rank / hostile / auth-cookies) from its
URL+structure tokens. Real corpus: the in-repo .bench-gate captures, labeled by type in the dir name.

JESPA = a learned linear energy classifier (multinomial logistic over hashed token features;
energy = -logit, lowest-energy class wins). Baselines: (a) majority class, (b) nearest type-centroid
in RAW token space (keyword). A real win = JESPA accuracy beats the STRONGER baseline by a margin,
two seeds, held-out by URL (no leakage). Honest either way — if learned features don't beat keyword
nearest-centroid, that is recorded as a negative.

Writes data/intent_type_result.json {seeds:[{seed, jespa_acc, baseline_acc, n_eval}]}.
"""
import os, re, json, glob, hashlib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "data", "intent_type_result.json")
D = 96
STOP = {"https", "http", "www", "com", "org", "io", "net", ""}

def load():
    seen = {}
    for meta in glob.glob(os.path.join(ROOT, ".bench-gate", "**", "capture.meta.json"), recursive=True):
        d = os.path.basename(os.path.dirname(meta))
        m = re.match(r"^\d+_([a-z-]+)_(https?_+.+)$", d)
        if not m:
            continue
        typ, url = m.group(1), m.group(2)
        toks = [t for t in re.split(r"[^a-z0-9]+", url.lower()) if t and t not in STOP and len(t) > 1]
        if len(set(toks)) < 3:
            continue
        seen[url] = (typ, sorted(set(toks)))             # dedup by url
    return [(u, t, tk) for u, (t, tk) in seen.items()]

def feat(toks):
    v = np.zeros(D)
    for t in toks:
        h = int(hashlib.md5(t.encode()).hexdigest(), 16)
        v[h % D] += 1.0
    n = np.linalg.norm(v)
    return v / n if n else v

def run_seed(rows, seed):
    rng = np.random.default_rng(seed)
    types = sorted(set(t for _, t, _ in rows))
    ti = {t: i for i, t in enumerate(types)}
    idx = rng.permutation(len(rows)); ntr = int(len(rows) * 0.7)
    tr, te = idx[:ntr], idx[ntr:]
    X = np.array([feat(rows[i][2]) for i in range(len(rows))])
    y = np.array([ti[rows[i][1]] for i in range(len(rows))])

    # JESPA: multinomial logistic energy classifier (gradient descent, the learned energy head)
    K = len(types); W = np.zeros((K, D)); lr = 0.5
    for _ in range(400):
        Z = X[tr] @ W.T; Z -= Z.max(1, keepdims=True); P = np.exp(Z); P /= P.sum(1, keepdims=True)
        Yoh = np.eye(K)[y[tr]]
        W -= lr * ((P - Yoh).T @ X[tr]) / len(tr) + 1e-3 * W
    jespa = float((np.argmax(X[te] @ W.T, 1) == y[te]).mean())

    # baseline (stronger of the two): majority class, and nearest type-centroid in RAW token space
    maj = float((np.full(len(te), np.bincount(y[tr]).argmax()) == y[te]).mean())
    cent = np.array([X[tr][y[tr] == k].mean(0) if (y[tr] == k).any() else np.zeros(D) for k in range(K)])
    nc = float((np.argmax(X[te] @ cent.T, 1) == y[te]).mean())
    base = max(maj, nc)
    return {"seed": seed, "jespa_acc": round(jespa, 4), "baseline_acc": round(base, 4),
            "majority": round(maj, 4), "keyword_nc": round(nc, 4), "n_eval": len(te)}

def main():
    rows = load()
    from collections import Counter
    print(f"[intent-type] real corpus: {len(rows)} unique routes, types={dict(Counter(t for _,t,_ in rows))}")
    seeds = [run_seed(rows, s) for s in (7, 13)]
    for s in seeds:
        print(f"  seed {s['seed']}: JESPA acc={s['jespa_acc']}  baseline(max maj={s['majority']},kw={s['keyword_nc']})={s['baseline_acc']}  "
              f"lift={s['jespa_acc']-s['baseline_acc']:+.4f}  n={s['n_eval']}")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump({"benchmark": "route access-pattern type classification (.bench-gate, 7-class)",
               "n_routes": len(rows), "seeds": seeds}, open(OUT, "w"), indent=2)
    print(f"[intent-type] wrote {OUT}")

if __name__ == "__main__":
    main()
