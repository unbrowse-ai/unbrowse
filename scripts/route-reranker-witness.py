#!/usr/bin/env python3
"""route-reranker-witness.py — the web-route scale of the fractal-routing thesis.

THESIS (the lever): "each JSON an EBM learnt is a ledger row in a KV cache; route
tools by a fractal of such EBMs; the wallet identity and its ledger rows tied to it
are its memory." This file witnesses that claim at the WEB-ROUTE scale, on the real
execution ledger in ~/.unbrowse/traces (≈15k traces), using the SAME primitive that
arc-energy-jepa/code/experience_reranker.py proved at the game-ACTION scale — an
EBM that re-ranks candidate routes by what-worked-previously, where the "EBM it
learnt" is literally a KV cache (context-key -> route-count vector).

The map from the ARC reranker to here (the fractal — same shape, wider action set):
    ARC 7 actions          ->  web routed-TOOL = trace `source`  (exa / marketplace /
                                live-capture / direct-fetch / ... — which tool resolved it)
    ARC game_id (identity) ->  trace `session_scope`             (the wallet/identity key)
    ARC winning subsequence->  a `success` trace                 (what worked)
    ARC last-k action ctx  ->  back-off over identity -> domain -> global specificity

The back-off levels ARE the thesis's memory hierarchy, most-specific first:
    L2  key=(identity, domain)  -> the wallet's OWN ledger    (personal memory)
    L1  key=(domain,)           -> the network's ledger       (shared memory)
    L0  key=()                  -> the global modal prior      (no memory — the baseline)
The energy = -log(smoothed P(route | most-specific seen context)); rank routes by
energy, fire the lowest. A held-out identity has no L2 rows, so it falls back to L1
(network memory) — that is the transfer claim: a brand-new wallet inherits the
network's route memory.

WITNESS (run this file): gates on the load-bearing claim — does ranking by
what-worked-previously beat the global-modal-route prior at predicting the route
that will SUCCEED, on the CONTESTED domains (>1 route wins, where the choice is
real), AND does it still transfer across HELD-OUT identities (leave-identity-out)?
Higher correct-route-first rate = fewer failed attempts before the win = faster
routing. Exit 0 iff the contested lift >= +0.05 AND leave-identity-out is positive.

Run:  python3 scripts/route-reranker-witness.py
Data: ~/.unbrowse/traces/*.json (real; override with UNBROWSE_TRACES).
"""
import glob
import json
import math
import os
import random
from collections import Counter, defaultdict

TRACES = os.environ.get("UNBROWSE_TRACES", os.path.expanduser("~/.unbrowse/traces"))
# The routed PRIMITIVE to rank. The fractal is one harness over many primitives:
#   source     — the coarse tool family (exa / marketplace / live-capture / …)
#   skill_id   — the actual SKILL/TOOL the LLM grabs (exa-web-search / a capture id)
#   endpoint_id— the specific endpoint within a skill
# The thesis: tools/endpoints/skills are all EBM primitives ranked by ledger energy.
ROUTE_TOKEN = os.environ.get("ROUTE_TOKEN", "source")
SEED = 7
ALPHA = 0.5          # add-alpha smoothing
MIN_LIFT = 0.05      # the gate bar (same as the ARC reranker)


def load_success_rows(path=TRACES):
    """Return [(identity, domain, route, latency_ms)] for every SUCCESS trace that
    carries all three keys — the per-identity ledger of what-worked. `route` is the
    ROUTE_TOKEN primitive (source / skill_id / endpoint_id)."""
    rows = []
    for f in glob.glob(os.path.join(path, "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("outcome") != "success":
            continue
        ident, dom, route = d.get("session_scope"), d.get("domain"), d.get(ROUTE_TOKEN)
        if ident and dom and route:
            rows.append((str(ident), str(dom), str(route), d.get("latency_ms")))
    return rows


# ---------------- the EBM = a back-off KV cache (the thesis's literal claim) -------
class RouteReranker:
    """energy(ctx, route) = -log smoothed P(route | most-specific seen context).
    tables[L] is the KV cache at back-off level L: a dict KEY(context) -> Counter of
    route -> count. Folded incrementally by fit(); this IS "each json in a kv cache".
    """

    def __init__(self, routes, alpha=ALPHA):
        self.routes = list(routes)
        self.alpha = alpha
        # L2=(identity,domain)  L1=(domain,)  L0=()  — most specific first
        self.tables = [defaultdict(Counter), defaultdict(Counter), defaultdict(Counter)]

    def _keys(self, identity, domain):
        return [(identity, domain), (domain,), ()]      # L2, L1, L0

    def fit(self, rows):
        for identity, domain, route, _lat in rows:
            for L, key in enumerate(self._keys(identity, domain)):
                self.tables[L][key][route] += 1.0
        return self

    def scores(self, identity, domain):
        """Energy per route from the most-specific context level that was seen."""
        for L, key in enumerate(self._keys(identity, domain)):     # specific -> global
            c = self.tables[L].get(key)
            if c is not None and sum(c.values()) > 0:
                tot = sum(c.values()) + self.alpha * len(self.routes)
                return {r: -math.log((c.get(r, 0) + self.alpha) / tot) for r in self.routes}
        # unseen at every level -> uniform (no memory)
        return {r: -math.log(1.0 / len(self.routes)) for r in self.routes}

    def top(self, identity, domain):
        e = self.scores(identity, domain)
        return min(self.routes, key=lambda r: (e[r], r))


def modal_route(train_rows):
    return Counter(r for _i, _d, r, _l in train_rows).most_common(1)[0][0]


def accuracy(pred_fn, test_rows):
    if not test_rows:
        return float("nan")
    return sum(1 for i, d, r, _l in test_rows if pred_fn(i, d) == r) / len(test_rows)


def eval_split(train_rows, test_rows, contested_domains, routes):
    ebm = RouteReranker(routes).fit(train_rows)
    modal = modal_route(train_rows)
    base = lambda _i, _d: modal
    pred = ebm.top
    con = [t for t in test_rows if t[1] in contested_domains]
    return {
        "base_all": accuracy(base, test_rows),
        "ebm_all": accuracy(pred, test_rows),
        "base_con": accuracy(base, con),
        "ebm_con": accuracy(pred, con),
        "n_test": len(test_rows),
        "n_con": len(con),
    }


def latency_color(rows, contested_domains, routes):
    """Honest secondary: among contested domains, is the energy-preferred route's
    median latency <= the global-modal route's? (routing 'faster' in wall-clock)."""
    ebm = RouteReranker(routes).fit(rows)
    modal = modal_route(rows)
    lat_by_route = defaultdict(list)
    for _i, d, r, lat in rows:
        if d in contested_domains and isinstance(lat, (int, float)):
            lat_by_route[(d, r)].append(lat)

    def med(xs):
        xs = sorted(xs)
        return xs[len(xs) // 2] if xs else None

    pref_lat, modal_lat = [], []
    for d in contested_domains:
        pr = ebm.top(None, d)            # network-level preference (identity unseen)
        for r in routes:
            xs = lat_by_route.get((d, r))
            if not xs:
                continue
            m = med(xs)
            if r == pr:
                pref_lat.append(m)
            if r == modal:
                modal_lat.append(m)
    return (med(pref_lat), med(modal_lat))


def main():
    rng = random.Random(SEED)
    rows = load_success_rows()
    routes = sorted({r for _i, _d, r, _l in rows})
    # contested = domains where >1 route succeeded (the choice is real)
    dom_routes = defaultdict(set)
    for _i, d, r, _l in rows:
        dom_routes[d].add(r)
    contested = {d for d, rs in dom_routes.items() if len(rs) > 1}

    print(f"# route-reranker witness [primitive={ROUTE_TOKEN}] — {len(rows)} success "
          f"traces, {len(routes)} distinct {ROUTE_TOKEN} primitives, "
          f"{len({i for i,_d,_r,_l in rows})} identities, "
          f"{len(contested)} contested domains (>1 primitive wins)\n")
    if len(routes) <= 12:
        print(f"primitives: {routes}\n")

    # split A: random 70/30 over success traces (generalize to similar play)
    idx = list(range(len(rows)))
    rng.shuffle(idx)
    cut = int(0.7 * len(rows))
    a_tr = [rows[i] for i in idx[:cut]]
    a_te = [rows[i] for i in idx[cut:]]
    A = eval_split(a_tr, a_te, contested, routes)

    # split B: leave-identity-out (a held-out WALLET inherits network memory only)
    idents = sorted({i for i, _d, _r, _l in rows})
    rng.shuffle(idents)
    hold = set(idents[: max(1, len(idents) // 3)])
    b_tr = [t for t in rows if t[0] not in hold]
    b_te = [t for t in rows if t[0] in hold]
    B = eval_split(b_tr, b_te, contested, routes)

    print("| split | scope | baseline (global modal) | back-off EBM (ledger memory) |")
    print("|-------|-------|-------------------------|------------------------------|")
    print(f"| random 70/30 | all      | {A['base_all']:.3f} | {A['ebm_all']:.3f} |")
    print(f"| random 70/30 | contested| {A['base_con']:.3f} | {A['ebm_con']:.3f}  (n={A['n_con']}) |")
    print(f"| leave-ident-out | all      | {B['base_all']:.3f} | {B['ebm_all']:.3f} |")
    print(f"| leave-ident-out | contested| {B['base_con']:.3f} | {B['ebm_con']:.3f}  (n={B['n_con']}) |")

    lift_con = A["ebm_con"] - A["base_con"]
    transfer_con = B["ebm_con"] - B["base_con"]
    print(f"\ncontested lift (random): +{lift_con:.3f}  | "
          f"contested transfer (leave-identity-out): +{transfer_con:.3f}")

    pref, modal = latency_color(rows, contested, routes)
    if pref is not None and modal is not None:
        print(f"latency color (contested median ms): ledger-preferred route {pref:.0f} ms "
              f"vs global-modal route {modal:.0f} ms")

    ok = lift_con >= MIN_LIFT and transfer_con > 0
    if ok:
        print(f"\nROUTE-RERANKER SIGNAL CONFIRMED: ranking routes by what-worked-previously "
              f"beats the global-modal prior by +{lift_con:.3f} on contested domains "
              f"(>= {MIN_LIFT}), and a HELD-OUT wallet inherits the network's route memory "
              f"(+{transfer_con:.3f}). The EBM is a KV cache of (identity,domain)->route "
              f"ledger rows; the per-identity ledger is the memory.")
    else:
        print(f"\nROUTE-RERANKER SIGNAL ABSENT: contested lift +{lift_con:.3f} "
              f"(need >= {MIN_LIFT}) / transfer +{transfer_con:.3f} (need > 0).")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
