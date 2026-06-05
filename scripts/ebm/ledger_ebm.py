#!/usr/bin/env python3
"""ledger_ebm.py — the EBM ledger-energy layers 2 & 3, on real data.

Layer 1 (already shipped, src/ranking/signals/ledger-energy.ts): a route's energy
is a back-off n-gram confidence P(success | domain, endpoint, source) over the
execution ledger. Train-free: a lesson is a witnessed ledger row, not a weight.

Layer 2 — self-improvement across N tries (the training curve). capture → index →
reuse: each successful execution appends a row, so a reused good route's energy
rises toward its true quality run-over-run, with NO optimizer. This module
measures that curve (`reuse_curve`).

Layer 3 — the learned contrastive energy head. The back-off statistic is cold on
(domain,endpoint) cells it has not seen ≥MIN_EVIDENCE times; it falls back to
NEUTRAL and cannot generalise. A small logistic energy head trained contrastively
on the SAME ledger rows (positives = successes, negatives = failures/fallbacks)
shares strength across features (source quality, domain priors, query n-grams) and
so ranks sparse/cold cells better than the back-off baseline. The ledger IS the
training set — no labels collected.

This module is pure-python (no numpy dep) so it runs anywhere the ledger does.
"""
from __future__ import annotations
import hashlib, json, math, os, random
from collections import defaultdict
from pathlib import Path

# ─── data ───────────────────────────────────────────────────────────────────
DOMAINS = [f"d{i}.com" for i in range(12)]
SOURCES = ["exa", "marketplace", "live-capture", "direct-fetch"]
ENDPOINTS = [f"ep{i}" for i in range(8)]
# A source's intrinsic reliability + a domain's friendliness combine into the true
# P(success) of a (domain, endpoint, source) route. The learned head can recover
# this generative structure from features; back-off can only count exact cells.
SOURCE_Q = {"exa": 0.82, "marketplace": 0.7, "live-capture": 0.55, "direct-fetch": 0.35}

def _true_quality(domain: str, endpoint: str, source: str, dom_bias: dict) -> float:
    q = SOURCE_Q[source] + dom_bias[domain] + (0.06 if endpoint in ("ep0", "ep1") else -0.04)
    return max(0.02, min(0.98, q))

def synth_ledger(n: int = 4000, seed: int = 7):
    """Deterministic synthetic execution ledger with a known latent structure."""
    rng = random.Random(seed)
    dom_bias = {d: rng.uniform(-0.18, 0.18) for d in DOMAINS}
    rows = []
    for _ in range(n):
        domain = rng.choice(DOMAINS)
        endpoint = rng.choice(ENDPOINTS)
        source = rng.choice(SOURCES)
        intent = f"task about {rng.choice(['weather','price','login','search','profile','docs'])} on {domain}"
        q = _true_quality(domain, endpoint, source, dom_bias)
        outcome = "success" if rng.random() < q else "failure"
        rows.append({"domain": domain, "endpoint_id": endpoint, "source": source,
                     "intent": intent, "outcome": outcome})
    return rows, dom_bias

def load_real_ledger(dir_: str | None = None):
    """Load real ~/.unbrowse/traces/*.json rows, or [] when absent/empty."""
    d = Path(dir_ or os.environ.get("UNBROWSE_TRACES", str(Path.home() / ".unbrowse" / "traces")))
    rows = []
    try:
        files = [f for f in d.iterdir() if f.suffix == ".json"]
    except Exception:
        return rows
    for f in files[:20000]:
        try:
            r = json.loads(f.read_text())
        except Exception:
            continue
        if r.get("outcome") in ("success", "failure") and r.get("endpoint_id"):
            # The runtime records the agent's intent under "goal" (telemetry.ts
            # emitRouteTrace); accept either key so the n-gram features are live.
            intent = r.get("intent") or r.get("goal", "")
            rows.append({"domain": r.get("domain", ""), "endpoint_id": r["endpoint_id"],
                         "source": r.get("source", ""), "intent": intent,
                         "outcome": r["outcome"]})
    return rows

# ─── layer 1: back-off baseline (mirrors ledger-energy.ts) ───────────────────
ALPHA, MIN_EVIDENCE = 1.0, 2

def fit_backoff(rows):
    de, ds, ep = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for r in rows:
        ok = r["outcome"] == "success"
        d, e, s = r["domain"], r["endpoint_id"], r["source"]
        for m, k in ((de, f"{d} {e}"), (ds, f"{d} {s}"), (ep, e)):
            m[k][1] += 1
            if ok: m[k][0] += 1
    return {"de": dict(de), "ds": dict(ds), "ep": dict(ep)}

def _rate(cell):
    if not cell or cell[1] < MIN_EVIDENCE: return None
    return (cell[0] + ALPHA) / (cell[1] + 2 * ALPHA)

def backoff_energy(model, domain, endpoint, source):
    for key, m in ((f"{domain} {endpoint}", model["de"]), (f"{domain} {source}", model["ds"]), (endpoint, model["ep"])):
        r = _rate(m.get(key))
        if r is not None: return r
    return 0.5  # NEUTRAL — cold, no opinion

# ─── layer 3: learned contrastive logistic energy head ───────────────────────
FEAT_DIM = 512

def _featurize(domain, endpoint, source, intent):
    """Hashed feature vector: route ids + query n-grams share strength across cells."""
    feats = {0: 1.0}  # bias
    def put(tok):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16) % (FEAT_DIM - 1) + 1
        feats[h] = 1.0
    put(f"src={source}"); put(f"dom={domain}"); put(f"ep={endpoint}")
    put(f"dom_ep={domain}|{endpoint}"); put(f"dom_src={domain}|{source}")
    words = (intent or "").lower().split()
    for w in words: put(f"w={w}")
    for a, b in zip(words, words[1:]): put(f"bg={a}_{b}")
    return feats

def _sigmoid(z): return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))

def train_head(rows, epochs=25, lr=0.3, l2=1e-4, seed=7):
    """Contrastive/logistic fit: P(success)=sigmoid(w·x). Energy = -(w·x)."""
    w = [0.0] * FEAT_DIM
    data = [(_featurize(r["domain"], r["endpoint_id"], r["source"], r.get("intent", "")),
             1.0 if r["outcome"] == "success" else 0.0) for r in rows]
    rng = random.Random(seed)
    for _ in range(epochs):
        rng.shuffle(data)
        for feats, y in data:
            z = sum(w[i] * v for i, v in feats.items())
            g = _sigmoid(z) - y
            for i, v in feats.items():
                w[i] -= lr * (g * v + l2 * w[i])
    return w

def head_score(w, domain, endpoint, source, intent=""):
    feats = _featurize(domain, endpoint, source, intent)
    return _sigmoid(sum(w[i] * v for i, v in feats.items()))

# ─── ranking metric: AUC (prob a positive outranks a negative) ───────────────
def auc(scores, labels):
    pos = [s for s, y in zip(scores, labels) if y == 1]
    neg = [s for s, y in zip(scores, labels) if y == 0]
    if not pos or not neg: return 0.5
    wins = ties = 0
    for p in pos:
        for n in neg:
            if p > n: wins += 1
            elif p == n: ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))

# ─── layer 2: the self-improvement reuse curve ───────────────────────────────
def reuse_curve(domain, endpoint, source, true_q, tries=12, seed=7):
    """Replay N executions of one route, appending witnessed rows; report the
    back-off energy after each try. capture→index→reuse: energy rises 0.5→true_q
    with no optimizer — the training curve."""
    rng = random.Random(seed)
    rows, curve = [], []
    for _ in range(tries):
        outcome = "success" if rng.random() < true_q else "failure"
        rows.append({"domain": domain, "endpoint_id": endpoint, "source": source,
                     "intent": "", "outcome": outcome})
        m = fit_backoff(rows)
        curve.append(backoff_energy(m, domain, endpoint, source))
    return curve

def spearman_monotone(curve):
    """Rank-correlation of (try index, energy): ~1.0 when energy rises with reuse."""
    n = len(curve)
    if n < 3: return 0.0
    order = sorted(range(n), key=lambda i: curve[i])
    rank = [0] * n
    for r, i in enumerate(order): rank[i] = r
    xs = list(range(n))
    mx, mr = sum(xs) / n, sum(rank) / n
    num = sum((xs[i] - mx) * (rank[i] - mr) for i in range(n))
    den = math.sqrt(sum((xs[i] - mx) ** 2 for i in range(n)) * sum((rank[i] - mr) ** 2 for i in range(n)))
    return num / den if den else 0.0
