"""The vault cycle — staking by abiding, not by lock-up (*Unbrowse Maintenance
Network*, the token section).

The platform collects a USDC fee on settled executions. That fee is returned to
the distributed holders pro rata to how much they hold and for how long they have
held it ("abiding"), rather than to whoever locked up the most in a staking
contract. This reference computes the distribution: each holder's share is
weighted by (balance x duration held), the fee pool is split by those weights,
and the split is conservative — every unit of the pool is assigned, nothing
minted. Holding longer or larger earns a larger share; holding nothing earns
nothing. No lock-up is required to participate; abiding is the only condition.
"""
from __future__ import annotations


def abiding_weights(holdings: dict[str, tuple[int, int]]) -> dict[str, int]:
    """weight = balance * duration_held. holdings: {holder: (balance, duration)}."""
    return {h: bal * dur for h, (bal, dur) in holdings.items()}


def distribute(fee_pool: int, holdings: dict[str, tuple[int, int]]) -> dict[str, int]:
    """Split `fee_pool` pro rata by abiding weight. Conservative (sum == pool)."""
    weights = abiding_weights(holdings)
    total = sum(weights.values())
    if total <= 0 or fee_pool <= 0:
        return {}
    out: dict[str, int] = {}
    assigned = 0
    # largest-remainder method so every integer unit of the pool is assigned
    rema: list[tuple[float, str]] = []
    for h, w in weights.items():
        exact = fee_pool * w / total
        base = int(exact)
        out[h] = base
        assigned += base
        rema.append((exact - base, h))
    leftover = fee_pool - assigned
    for _, h in sorted(rema, reverse=True)[:leftover]:
        out[h] += 1
    return out
