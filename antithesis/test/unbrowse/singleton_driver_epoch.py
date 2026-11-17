#!/usr/bin/env python3
"""Days pass on the chain while calls and claims are in flight: the custom fault that moves Settlement's clock. An
epoch is a count of blocks (R1.28), so mining blocks rolls epochs over between a call's cap read and its line, between
a line and its claim, and past claim windows, withdrawal delays and delistings' release. Each step first jumps the
block timestamp by as much, in one block: what a proposer skewing the clock can do, which must move no epoch.
A live network never lets the node move its clock (`advance_day` is refused there); Anvil's `anvil_mine` and
`evm_increaseTime` are the chain doing it by itself.

Menu axis: steps of one epoch, two (a claim window closing, a withdrawal maturing) and fifteen (half a free-failure
window), at most sixty days in all, so the agents' year-long keys never expire.
"""

import time

from antithesis.assertions import always, reachable
from antithesis.random import random_choice

import helper_chain as C

STEPS = [1, 2, 15]
MOST_DAYS = 60


def main():
    try:
        length = C.contracts()["settlement"].call("epochBlocks")[0]
    except C.ChainError:
        return
    moved = 0
    for _ in range(random_choice([1, 2, 3])):
        time.sleep(random_choice([1, 10, 30]))
        step = random_choice(STEPS)
        if moved + step > MOST_DAYS:
            break
        try:
            s = C.contracts()["settlement"]
            before = s.call("epoch")[0]
            C.advance_time(step * C.EPOCH_SECONDS)
            after = s.call("epoch")[0]
            head = C.block_number()
            C.mine_epochs(step, length)
        except C.ChainError:
            continue
        # epochs-are-counted-in-blocks (spec R1.28, R0.7): one block mined after a clock jump is one block, so the
        # epoch is what the block number says, read after it so a block the nodes mined between never fails it. A
        # contract that counts epochs from the timestamp runs ahead of it here.
        always(after <= head // length, "a clock jump with a single block never moves the epoch: epochs are counted in blocks (R1.28)", {"before": before, "after": after, "head": head, "seconds": step * C.EPOCH_SECONDS})
        moved += step
        reachable("the chain's blocks moved epochs on while the nodes worked", {"epochs": step})


if __name__ == "__main__":
    main()
