#!/usr/bin/env python3
"""Settlement's invariants checked while drivers and faults run: it holds no UNB, its USDC is exactly what it owes,
no line is paid twice or past its cap, the fetch holds exactly what it owes, and a contributor can always withdraw
what the fetch owes it (helper_invariants.py). Beside them, two that are read the same way: each owner has one
ERC-8004 identity, and no receipt file ever shrinks. A chain that can't be read this time is skipped.
"""

import helper_invariants

if __name__ == "__main__":
    helper_invariants.check()
    helper_invariants.identities()
    helper_invariants.ledgers()
