"""Bonding, challenge, and slashing — the collateralised-accountability layer of
*Unbrowse Maintenance Network*.

A maintainer bonds stake to become eligible (bonding buys credibility and
eligibility; it explicitly does NOT buy ranking). When a maintainer's proof of
indexing is challenged, the dispute is adjudicated by re-derivation against the
content-addressed truth: if the maintainer attested a content hash that does not
match the canonical content, the maintainer is slashed and the honest challenger
is rewarded from the slashed bond. If the challenge is spurious (the attestation
was correct), the challenger's challenge-bond is forfeit instead. The arithmetic
is conservative — stake is neither created nor destroyed, only moved — so the
ledger of bonds always balances.
"""
from __future__ import annotations
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from network.proof_of_indexing import verify_poi  # noqa: E402


class InsufficientBond(Exception):
    pass


class BondLedger:
    """Conservative ledger of bonded stake. Total supply is invariant."""

    def __init__(self):
        self.free: dict[str, int] = {}      # liquid balance
        self.bonded: dict[str, int] = {}    # locked stake

    def credit(self, who: str, amt: int):
        self.free[who] = self.free.get(who, 0) + amt

    def total(self) -> int:
        return sum(self.free.values()) + sum(self.bonded.values())

    def bond(self, who: str, amt: int):
        if self.free.get(who, 0) < amt:
            raise InsufficientBond(f"{who} has {self.free.get(who,0)} < {amt}")
        self.free[who] -= amt
        self.bonded[who] = self.bonded.get(who, 0) + amt

    def challenge(self, maintainer: str, poi_entry: dict, observed_content: bytes,
                  challenger: str, stake: int) -> dict:
        """Adjudicate a challenge by re-derivation. Returns the verdict.

        `observed_content` is the canonical content the challenger presents. The
        attestation is honest iff verify_poi(entry, observed_content) holds.
        """
        self.bond(challenger, stake)  # challenger must put skin in the game
        honest = verify_poi(poi_entry, observed_content)
        if not honest:
            # maintainer lied: slash up to `stake` from the maintainer's bond,
            # transfer to the challenger; release the challenger's stake.
            slashed = min(stake, self.bonded.get(maintainer, 0))
            self.bonded[maintainer] = self.bonded.get(maintainer, 0) - slashed
            self.bonded[challenger] -= stake
            self.free[challenger] = self.free.get(challenger, 0) + stake + slashed
            return {"verdict": "slashed", "subject": maintainer, "amount": slashed}
        else:
            # spurious challenge: challenger forfeits the challenge-bond to maintainer
            self.bonded[challenger] -= stake
            self.bonded[maintainer] = self.bonded.get(maintainer, 0) + stake
            return {"verdict": "challenge_failed", "subject": challenger, "amount": stake}
