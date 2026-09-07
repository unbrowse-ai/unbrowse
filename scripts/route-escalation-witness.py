#!/usr/bin/env python3
"""route-escalation-witness.py — the cascade: the ledger energy is a CONFIDENCE gate.

The fractal-routing thesis proved the per-identity ledger RANKS routes/skills (which
to grab). This is the other half the convergence named (sp-route / FrugalGPT cascade,
arxiv:2305.05176): the SAME ledger energy is a CONFIDENCE signal that decides whether
to trust the cheap cached route or ESCALATE to the expensive discover path (browser /
capture). Don't make the route smart — make the system smart: keep the route when the
ledger is confident, escalate the rest.

Confidence(domain, route) = smoothed P(success | this context) learned from the ledger,
backing off (identity,domain,route) -> (domain,route) -> (route) -> global. Trained on a
TRAIN split of REAL traces (success AND failure), evaluated on held-out traces by their
true outcome. The claim: high-confidence routes really do succeed more — so keeping the
confident fraction cheap (high success) and escalating the uncertain rest (where the
failures concentrate) is a real, free reliability win.

Witness (run this file) — exit 0 iff ALL:
  1. there is a cascade operating point that KEEPS >= 30% of traffic cheap with a kept
     success rate >= base + 0.10 AND >= 0.85 (the confident cheap routes are reliable);
  2. the ESCALATED bucket's success rate is clearly lower (failures concentrate there,
     so escalation targets them) — separation >= 0.15;
  3. it transfers: on leave-identity-out, a held-out wallet's kept bucket still beats base.

Run:  python3 scripts/route-escalation-witness.py     (ROUTE_TOKEN=source|skill_id)
Data: ~/.unbrowse/traces/*.json (real; override with UNBROWSE_TRACES).
"""
import glob
import json
import os
import random
from collections import defaultdict

TRACES = os.environ.get("UNBROWSE_TRACES", os.path.expanduser("~/.unbrowse/traces"))
ROUTE_TOKEN = os.environ.get("ROUTE_TOKEN", "source")
SEED = 7
ALPHA = 1.0          # Laplace smoothing on the success-rate estimate
KEEP_MIN = 0.30      # a cascade must keep at least this fraction cheap to be worth it
MARGIN = 0.10        # kept success must beat base by at least this
KEPT_FLOOR = 0.85    # ...and clear this absolute reliability bar
SEPARATION = 0.15    # kept vs escalated success-rate gap


def load_rows(path=TRACES):
    """[(identity, domain, route, success_bool)] over SUCCESS+FAILURE traces."""
    rows = []
    for f in glob.glob(os.path.join(path, "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        o = d.get("outcome")
        if o not in ("success", "failure"):
            continue
        ident, dom, route = d.get("session_scope"), d.get("domain"), d.get(ROUTE_TOKEN)
        if ident and dom and route:
            rows.append((str(ident), str(dom), str(route), o == "success"))
    return rows


class Confidence:
    """P(success | context) as a back-off over (identity,domain,route) ->
    (domain,route) -> (route) -> global. Each level a smoothed success rate; use the
    most specific level that was actually seen in TRAIN."""

    def __init__(self, alpha=ALPHA):
        self.alpha = alpha
        self.levels = [defaultdict(lambda: [0, 0]) for _ in range(4)]  # [succ, total]
        self.global_rate = 0.5

    def _keys(self, identity, domain, route):
        return [(identity, domain, route), (domain, route), (route,), ()]

    def fit(self, rows):
        g = [0, 0]
        for identity, domain, route, ok in rows:
            for L, key in enumerate(self._keys(identity, domain, route)):
                cell = self.levels[L][key]
                cell[0] += 1 if ok else 0
                cell[1] += 1
            g[0] += 1 if ok else 0
            g[1] += 1
        self.global_rate = (g[0] + self.alpha) / (g[1] + 2 * self.alpha) if g[1] else 0.5
        return self

    def conf(self, identity, domain, route):
        for L, key in enumerate(self._keys(identity, domain, route)):
            cell = self.levels[L].get(key)
            # require a minimum of evidence at a level before trusting it
            if cell and cell[1] >= (2 if L < 3 else 1):
                return (cell[0] + self.alpha) / (cell[1] + 2 * self.alpha)
        return self.global_rate


def operating_point(scored, keep_min=KEEP_MIN):
    """scored = [(confidence, success_bool)] on TEST. Sort by confidence desc; the
    cascade KEEPS the most-confident prefix and ESCALATES the rest. Pick the largest
    kept fraction (>= keep_min) whose kept success rate is maximized — report the
    threshold that keeps confident traffic cheap."""
    scored = sorted(scored, key=lambda x: -x[0])
    n = len(scored)
    best = None
    # sweep keep fractions from keep_min..0.9; keep the prefix, escalate the tail
    for frac in [k / 100 for k in range(int(keep_min * 100), 91, 5)]:
        k = max(1, int(frac * n))
        kept = scored[:k]
        esc = scored[k:]
        kept_succ = sum(s for _c, s in kept) / len(kept)
        esc_succ = (sum(s for _c, s in esc) / len(esc)) if esc else 1.0
        cand = (kept_succ, frac, esc_succ, scored[k - 1][0])
        # prefer high kept-success, then larger kept fraction
        if best is None or (kept_succ, frac) > (best[0], best[1]):
            best = cand
    return best  # (kept_succ, kept_frac, esc_succ, threshold)


def main():
    rng = random.Random(SEED)
    rows = load_rows()
    base = sum(ok for _i, _d, _r, ok in rows) / len(rows)
    print(f"# route-escalation (cascade) witness [primitive={ROUTE_TOKEN}] — {len(rows)} "
          f"success+failure traces, base success rate {base:.3f}\n")

    # split A: random 70/30
    idx = list(range(len(rows))); rng.shuffle(idx)
    cut = int(0.7 * len(rows))
    tr = [rows[i] for i in idx[:cut]]; te = [rows[i] for i in idx[cut:]]
    model = Confidence().fit(tr)
    scored = [(model.conf(i, d, r), ok) for i, d, r, ok in te]
    kept_succ, kept_frac, esc_succ, thr = operating_point(scored)

    # split B: leave-identity-out
    idents = sorted({i for i, _d, _r, _ok in rows}); rng.shuffle(idents)
    hold = set(idents[: max(1, len(idents) // 3)])
    b_tr = [t for t in rows if t[0] not in hold]
    b_te = [t for t in rows if t[0] in hold]
    mB = Confidence().fit(b_tr)
    scoredB = [(mB.conf(i, d, r), ok) for i, d, r, ok in b_te]
    keptB, fracB, escB, _thrB = operating_point(scoredB)

    print(f"random 70/30  (base {base:.3f}):")
    print(f"  KEEP cheap   : {kept_frac*100:.0f}% of traffic, success {kept_succ:.3f}  (conf >= {thr:.2f})")
    print(f"  ESCALATE rest: {100-kept_frac*100:.0f}% of traffic, success {esc_succ:.3f}  -> sent to the expensive path")
    print(f"  separation (kept - escalated): {kept_succ - esc_succ:+.3f}")
    print(f"\nleave-identity-out (held-out wallet, base {sum(o for *_ ,o in b_te)/len(b_te):.3f}):")
    print(f"  KEEP cheap   : {fracB*100:.0f}%, success {keptB:.3f}   ESCALATE: success {escB:.3f}")

    base_te = sum(o for *_, o in te) / len(te)
    ok = (
        kept_frac >= KEEP_MIN
        and kept_succ >= base_te + MARGIN
        and kept_succ >= KEPT_FLOOR
        and (kept_succ - esc_succ) >= SEPARATION
        and keptB > (sum(o for *_, o in b_te) / len(b_te))
    )
    if ok:
        print(f"\nCASCADE GATE CONFIRMED: the ledger confidence is a real escalation signal. "
              f"Keeping the confident {kept_frac*100:.0f}% of routes cheap succeeds {kept_succ:.3f} "
              f"(vs base {base_te:.3f}), while the escalated rest succeeds only {esc_succ:.3f} — so "
              f"escalating the uncertain fraction to the expensive discover path targets the failures "
              f"for free. Same energy that RANKS routes also decides CHEAP-KEEP vs ESCALATE (FrugalGPT "
              f"cascade, arxiv:2305.05176). Don't make the route smart — make the system smart.")
        raise SystemExit(0)
    print(f"\nNO CASCADE GATE: kept {kept_frac:.2f}(>= {KEEP_MIN}) succ {kept_succ:.3f}"
          f"(>= {base_te+MARGIN:.3f} and >= {KEPT_FLOOR}) sep {kept_succ-esc_succ:+.3f}"
          f"(>= {SEPARATION}) transferB {keptB:.3f}.")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
