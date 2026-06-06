#!/usr/bin/env python3
"""codebench_reliability.py — make the 25%->100% claim RELIABLE (jesus-pattern Test/Judge).
Two hardenings the single-seed witness lacks:
  1. SEED-STABILITY on the trained families — run several seeds, the gain must hold EVERY time.
  2. GENERALIZATION to UNSEEN families (gcd, digit-product, vowel-count — code-writable, NOT
     in the 7 trained) — separates "learned write+execute as a skill" from "memorized 7 templates".
Gate: improved beats base on trained families every seed AND >= target; the unseen-family
transfer is reported honestly either way (it is the real reliability insight)."""
import sys, random, statistics
import codebench_witness as cbw

def f_gcd(r):
    import math; a, b = r.randint(12, 500), r.randint(12, 500)
    return (f"What is the greatest common divisor of {a} and {b}? Write Python and print it.", str(math.gcd(a, b)))
def f_digitprod(r):
    n = r.randint(100, 9999); p = 1
    for ch in str(n): p *= int(ch)
    return (f"What is the product of the digits of {n}? Write Python and print it.", str(p))
def f_vowels(r):
    w = r.choice(["benchmark", "reliability", "distillation", "execution", "retrieval", "factorial", "witness"])
    return (f"How many vowels (a,e,i,o,u) are in the word '{w}'? Write Python and print it.",
            str(sum(1 for c in w if c in "aeiou")))
HELDOUT = [f_gcd, f_digitprod, f_vowels]

def heldout_bench(seed, per=6):
    r = random.Random(seed); items = []
    for fam in HELDOUT:
        for _ in range(per): q, a = fam(r); items.append((q, a))
    return items

def main():
    if not cbw.train_if_absent(): print("RELIABILITY FAIL: train"); return 1
    SEEDS = [2, 3, 4, 5]
    print("== seed-stability on TRAINED families (42 items/seed) ==", flush=True)
    ba, ia = [], []
    for s in SEEDS:
        bench = cbw.gen_bench(seed=s, per_family=6)
        b = cbw.serve_and_bench(cbw.BASELINE_ADAPTER, bench); i = cbw.serve_and_bench(cbw.IMPROVED, bench)
        ba.append(b); ia.append(i); print(f"  seed {s}: base {b*100:.1f}% -> improved {i*100:.1f}%", flush=True)
    bmean, imean = statistics.mean(ba), statistics.mean(ia)
    stable = all(i > b + cbw.MARGIN for b, i in zip(ba, ia))
    print(f"  => base {bmean*100:.1f}% (±{(max(ba)-min(ba))*100:.0f}) | improved {imean*100:.1f}% (±{(max(ia)-min(ia))*100:.0f}) | every-seed-beats={stable}", flush=True)
    print("== generalization to UNSEEN families (gcd, digit-product, vowels; 18 items) ==", flush=True)
    hb = heldout_bench(seed=7)
    hbase = cbw.serve_and_bench(cbw.BASELINE_ADAPTER, hb); himp = cbw.serve_and_bench(cbw.IMPROVED, hb)
    transfer = himp > hbase + cbw.MARGIN
    print(f"  held-out families: base {hbase*100:.1f}% -> improved {himp*100:.1f}%", flush=True)
    ok = stable and imean >= cbw.TARGET
    print(f"\nRELIABILITY {'PASS' if ok else 'FAIL'}: trained-family gain seed-stable "
          f"(improved {imean*100:.0f}% vs base {bmean*100:.0f}%, every seed). Unseen-family transfer: "
          f"base {hbase*100:.0f}% -> improved {himp*100:.0f}% — "
          f"{'TRANSFERS (a write+execute SKILL, not 7 memorized templates)' if transfer else 'does NOT transfer (gain is family-specific — honest scope: in-distribution only)'}.")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
