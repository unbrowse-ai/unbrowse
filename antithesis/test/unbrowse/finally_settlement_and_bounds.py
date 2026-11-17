#!/usr/bin/env python3
"""After every command has finished: the settlement invariants once more, on the final state, and the lines each
caller wrote, bounded by what the workload saw. A call acknowledged as paid wrote a passed line; no more passed
lines exist than paid calls were tried (a call whose reply was lost may have written one, so that is the upper bound).
"""

from antithesis.assertions import always_greater_than_or_equal_to, always_less_than_or_equal_to

import helper_invariants
import helper_nodes as N


def main():
    # Faults have stopped; the chain and the nodes may need a moment to answer again.
    N.wait(lambda: helper_invariants.check(), 300, every=5)
    helper_invariants.identities()
    helper_invariants.ledgers()
    with N.db() as c:
        rows = c.execute("SELECT node, outcome, paid, cached FROM calls").fetchall()
    for name in N.CALLERS:
        lines = N.wait(lambda: N.receipts(name) or [("none",)], 60, every=2)
        if not lines:
            continue  # the files never read whole: nothing to bound
        passed = sum(1 for x in lines if len(x) == 3 and x[2].get("passed"))
        acked = sum(1 for n, o, paid, cached in rows if n == name and o == "ok" and paid and not cached)
        tried = sum(1 for n, _o, _p, _c in rows if n == name)  # an unreachable reply may still have run
        always_greater_than_or_equal_to(passed, acked, "every call acknowledged as paid left a passed line", {"node": name})
        always_less_than_or_equal_to(passed, tried, "no more passed lines exist than calls were tried", {"node": name})


if __name__ == "__main__":
    main()
