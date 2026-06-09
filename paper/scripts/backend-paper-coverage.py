#!/usr/bin/env python3
"""backend-paper-coverage.py — bidirectional traceability between the backend and the papers.

The papers are a specification; the backend is the implementation. This tool measures
how much of the backend is REPRESENTED by the papers, in two independent ways:

  1. ANCHORED coverage  — modules formally bound to a paper claim in paper/anchors.tsv
                          (the gate-enforced, mechanical correspondence used by paper-gate.sh).
  2. TOPICAL coverage   — modules a paper *discusses*, declared in paper/backend-coverage.tsv
                          (module <TAB> paper-id). A first-cut map, editable as data.

It then prints the orphan set: backend modules no paper represents at all — the
"detail not yet represented against the papers."

Inventory = backend/src/{routes,services,middleware}/*.ts, keyed as e.g. "services/flex".

  python3 paper/scripts/backend-paper-coverage.py            # report only (always exit 0)
  python3 paper/scripts/backend-paper-coverage.py --strict   # + exit 1 on data drift (ghost row / invalid paper-id); orphans allowed
  python3 paper/scripts/backend-paper-coverage.py --gate      # CI gate: exit 1 if ANY module is unclassified, OR invalid id, OR ghost row

Exit 0 = clean. Exit 1 = --strict drift / --gate failure. Exit 2 = usage/file error.
"""
import os, sys, re, glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BSRC = os.path.join(ROOT, "backend", "src")
COVERAGE_TSV = os.path.join(ROOT, "paper", "backend-coverage.tsv")
ANCHORS_TSV = os.path.join(ROOT, "paper", "anchors.tsv")

PAPERS = {
    "internal-apis":  "Internal APIs Are All You Need (discovery / route library)",
    "energy-ranking": "Energy-Based Route Ranking (selection)",
    "execute":        "Execute, Don't Guess (routing / execute path)",
    "crypto":         "Crypto Was All You Needed (identity / auth / payments / ZK)",
    "maintenance":    "Unbrowse Maintenance Network (freshness / proof-of-indexing)",
}

# The firmament: a module's state is one of three, never conflated.
#   anchored     — gate-enforced claim in anchors.tsv (a subset overlay on topical)
#   topical      — a paper (above PAPERS) discusses it, declared in backend-coverage.tsv
#   out-of-scope — DELIBERATELY not paper-claimed (operational/growth/infra); declared
#                  with paper-id "out-of-scope" in backend-coverage.tsv (the new skin)
#   (orphan)     — none of the above: NOT-YET-TRIAGED. The number to drive to zero.
OUT_OF_SCOPE = "out-of-scope"

def inventory():
    mods = set()
    for kind in ("routes", "services", "middleware"):
        for f in glob.glob(os.path.join(BSRC, kind, "*.ts")):
            name = os.path.basename(f)[:-3]
            if name.endswith(".types") or name.endswith(".test"):
                continue
            mods.add(f"{kind}/{name}")
    return mods

def read_topical():
    m = {}
    if not os.path.exists(COVERAGE_TSV):
        return m
    for line in open(COVERAGE_TSV, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        mod, paper = parts[0].strip(), parts[1].strip()
        m.setdefault(mod, paper)
    return m

def _papers_text_lower():
    blob = ""
    for tex in glob.glob(os.path.join(ROOT, "paper", "*.tex")):
        try:
            blob += open(tex, encoding="utf-8", errors="ignore").read()
        except OSError:
            pass
    return blob.lower()

def read_anchored():
    """A backend module counts as ANCHORED only if it is *gate-enforceable*: some
    anchors.tsv row binds a claim-substring to that module AND the claim actually
    appears in a paper (mirrors paper-gate.sh's `grep -qiF claim paper` condition).
    A row whose claim is in no paper is inert — paper-gate skips it — so it does not count."""
    anchored = set()
    if not os.path.exists(ANCHORS_TSV):
        return anchored
    papers = _papers_text_lower()
    for line in open(ANCHORS_TSV, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        claim, anchor = parts[0].strip(), parts[1].strip()
        m = re.match(r"backend/src/(routes|services|middleware)/([A-Za-z0-9_.-]+)\.ts$", anchor)
        if not m:
            continue
        if claim.lower() in papers:           # enforceable (claim present in some paper)
            anchored.add(f"{m.group(1)}/{m.group(2)}")
    return anchored

def main(argv):
    strict = "--strict" in argv[1:]
    mods = inventory()
    topical = read_topical()
    anchored = read_anchored()
    total = len(mods) or 1  # guard: an empty backend tree must not ZeroDivision

    # integrity: map rows that name modules not in the inventory
    ghost = sorted(set(topical) - mods)

    represented_topical = sorted(m for m in topical if m in mods and topical[m] != OUT_OF_SCOPE)
    out_of_scope = sorted(m for m in topical if m in mods and topical[m] == OUT_OF_SCOPE)
    orphans = sorted(mods - set(topical))  # untriaged: in neither the topical nor out-of-scope buckets
    valid_ids = set(PAPERS) | {OUT_OF_SCOPE}
    invalid = sorted(m for m in topical if m in mods and topical[m] not in valid_ids)

    per_paper = {p: [] for p in PAPERS}
    for m in represented_topical:
        per_paper.setdefault(topical[m], []).append(m)

    print(f"=== backend ↔ paper coverage ===  (backend modules: {total})")
    print()
    print(f"ANCHORED coverage (gate-enforced, paper/anchors.tsv): {len(anchored & mods)}/{total} "
          f"= {100*len(anchored & mods)/total:.1f}%")
    print(f"  anchored modules: {', '.join(sorted(anchored & mods)) or '(none)'}")
    print()
    print(f"TOPICAL coverage (first-cut, paper/backend-coverage.tsv): {len(represented_topical)}/{total} "
          f"= {100*len(represented_topical)/total:.1f}%")
    for p, label in PAPERS.items():
        items = sorted(per_paper.get(p, []))
        print(f"  [{p:13}] {len(items):>3} modules — {label}")
    print()
    print(f"OUT-OF-SCOPE (deliberately not paper-claimed): {len(out_of_scope)}/{total} = {100*len(out_of_scope)/total:.1f}%")
    print()
    print(f"ORPHANS / NOT-YET-TRIAGED (drive to zero): {len(orphans)}/{total} = {100*len(orphans)/total:.1f}%")
    # group orphans by kind for readability
    for kind in ("routes", "services", "middleware"):
        ks = [o.split("/", 1)[1] for o in orphans if o.startswith(kind + "/")]
        if ks:
            print(f"  {kind}: {', '.join(ks)}")
    print()
    if ghost:
        print(f"WARNING: {len(ghost)} coverage.tsv row(s) name modules not in the backend: {', '.join(ghost)}")

    # --- the luminary: a falsifiable gate that governs the representation over time ---
    gate = "--gate" in argv[1:]
    problems = []
    if orphans:
        problems.append(f"{len(orphans)} not-yet-triaged module(s) (classify in backend-coverage.tsv): {', '.join(orphans)}")
    if invalid:
        problems.append(f"{len(invalid)} invalid paper-id(s): {', '.join(m+'='+topical[m] for m in invalid)}")
    if ghost:
        problems.append(f"{len(ghost)} ghost row(s) naming missing modules: {', '.join(ghost)}")
    if gate:
        print()
        if problems:
            for p in problems:
                print(f"GATE-FAIL: {p}")
            print("BACKEND-COVERAGE GATE FAIL — every backend module must be classified (topical or out-of-scope) with a valid paper-id.")
            return 1
        print(f"BACKEND-COVERAGE GATE PASS — all {total} modules classified, every paper-id valid, no ghost rows.")
        return 0
    if strict and (ghost or invalid):
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
