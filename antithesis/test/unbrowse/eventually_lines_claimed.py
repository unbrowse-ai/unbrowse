#!/usr/bin/env python3
"""passed-lines-are-claimed-within-their-window and background-pass-completes-after-chain-faults-stop: once faults
stop, the background pass claims what the callers' agents signed. For every agent key and every voucher epoch still
in its claim window (this epoch and the last), the chain's claimed total reaches the total of the passed lines
signed for it, within a few passes. The claim goes once the lines are worth their gas, or on the first pass after
their epoch closes (chain/claims.rs `claim_due`), so the wait runs until the window would close by the clock it is read in.
"""

import time

from antithesis.assertions import always_greater_than_or_equal_to

import helper_chain as C
import helper_nodes as N

USDC_UNITS = 10**6
PASSES = 6  # a background pass a minute (main.rs `claim_loop`), with room for a slow one


def owed():
    """(payer, agent, epoch) -> (signed units, claimed units) for the epochs still claimable."""
    s = C.contracts()["settlement"]
    now = s.call("epoch")[0]
    out = {}
    for a in N.agents():
        payer = N.OWNER[a["node"]]
        lines = [(e, l) for i, e, l in N.receipts(a["node"]) if i == a["idx"] and l.get("passed") and e + 1 >= now]
        for epoch in {e for e, _l in lines}:
            signed = sum(round(l["amount"] * USDC_UNITS) for e, l in lines if e == epoch)
            out[(payer, a["address"], epoch)] = (signed, s.call("claimedOf", payer, a["address"], epoch)[0])
    return out


def main():
    if not N.recall("roles"):
        return
    try:
        if C.rolled_back(C.block_number()):
            return  # a restarted Anvil lost blocks: what the nodes claimed may be gone
    except C.ChainError:
        pass
    last = {}

    def settled():
        last.clear()
        last.update(owed())
        return all(claimed >= signed for signed, claimed in last.values())

    N.wait(settled, PASSES * 60, every=15)
    for (payer, agent, epoch), (signed, claimed) in last.items():
        always_greater_than_or_equal_to(claimed, signed, "every passed line in its claim window is claimed once faults stop", {"payer": payer, "agent": agent, "epoch": epoch})


if __name__ == "__main__":
    main()
