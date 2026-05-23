#!/usr/bin/env python3
"""
Verify bench corpus has sufficient category diversity.
Categories are declared via comment tags: # [CAT] Description
A probe belongs to the last seen category header above it.
Exit 0 = all minimums met. Exit 1 = one or more categories short.
"""
import sys
import re
from pathlib import Path
from collections import defaultdict

CORPUS = Path(__file__).parent / "bench-on-change.txt"

MINIMUMS = {
    "REST_PUBLIC": 5,
    "SSR_HEAVY": 3,
    "CF_GATED": 3,
    "ANTIBOT_AGGR": 3,
    "GRAPHQL": 3,
    "ECOMMERCE": 3,
    "SOCIAL": 3,
    "GOV_PUBLIC": 2,
}
TOTAL_MIN = 35

counts: dict = defaultdict(list)
current_cat = None
total = 0

for line in CORPUS.read_text().splitlines():
    stripped = line.strip()
    if not stripped:
        continue
    if stripped.startswith("#"):
        m = re.search(r"\[([A-Z_]+)\]", stripped)
        if m:
            current_cat = m.group(1)
        continue
    if "|" in stripped and current_cat:
        counts[current_cat].append(stripped)
        total += 1

ok = True
rows = []

for cat, min_n in MINIMUMS.items():
    n = len(counts.get(cat, []))
    status = "OK" if n >= min_n else "FAIL"
    if status == "FAIL":
        ok = False
    rows.append((status, cat, n, min_n))

total_status = "OK" if total >= TOTAL_MIN else "FAIL"
if total_status == "FAIL":
    ok = False

for status, cat, n, min_n in rows:
    print(f"  [{status}] {cat}: {n}/{min_n}")

print(f"  [{total_status}] TOTAL: {total}/{TOTAL_MIN}")
print()

# Probes not under any category tag
tagged = sum(len(v) for v in counts.values())
uncategorized = total - tagged
if uncategorized:
    print(f"  NOTE: {uncategorized} probe(s) have no category tag")

if not ok:
    missing = [
        (cat, min_n - len(counts.get(cat, [])))
        for cat, min_n in MINIMUMS.items()
        if len(counts.get(cat, [])) < min_n
    ]
    print("\n  NEEDED:")
    for cat, deficit in missing:
        print(f"    {cat}: +{deficit} probe(s)")
    if total < TOTAL_MIN:
        print(f"    TOTAL: +{TOTAL_MIN - total} probe(s)")
    sys.exit(1)

sys.exit(0)
