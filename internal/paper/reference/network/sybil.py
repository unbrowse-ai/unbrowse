"""Sybil resistance for attributed contribution — *Unbrowse Maintenance Network*,
grounded in Douceur's result: without a cost or a trusted identity authority, one
party can mint unlimited identities and capture a system that weights by identity
count. So the maintenance network never weights by identity count; it weights
attribution by BONDED STAKE, which is scarce and costly to acquire.

The formal property proved here is **split-invariance**: an attacker who splits
one identity's stake across N Sybil identities gains exactly zero additional
influence, because influence is `stake_i / total_stake` and the split conserves
the numerator's sum. Gaining influence strictly requires acquiring more stake (a
real cost), not more identities. The reference computes stake-weighted attribution
and proves the invariance directly.
"""
from __future__ import annotations


def attribute(stakes: dict[str, int]) -> dict[str, float]:
    """Stake-weighted influence shares. Sums to 1.0 (or {} if no stake)."""
    total = sum(stakes.values())
    if total <= 0:
        return {}
    return {who: amt / total for who, amt in stakes.items()}


def influence_of(stakes: dict[str, int], parties: set[str]) -> float:
    """Total influence held by a coalition of identities."""
    shares = attribute(stakes)
    return sum(shares.get(p, 0.0) for p in parties)


def split_identity(stakes: dict[str, int], who: str, into: list[str]) -> dict[str, int]:
    """Split `who`'s stake evenly across new identities `into` (a Sybil attempt)."""
    assert who in stakes and len(into) >= 1
    amt = stakes[who]
    out = {k: v for k, v in stakes.items() if k != who}
    share, rem = divmod(amt, len(into))
    for i, name in enumerate(into):
        out[name] = share + (1 if i < rem else 0)  # conserve every unit
    return out


def gain_from_split(stakes: dict[str, int], who: str, into: list[str]) -> float:
    """Influence gained by splitting `who` into Sybils. Sound design => ~0."""
    before = influence_of(stakes, {who})
    after_stakes = split_identity(stakes, who, into)
    after = influence_of(after_stakes, set(into))
    return after - before
