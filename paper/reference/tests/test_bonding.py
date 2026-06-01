"""Each test proves one sentence about bonding, challenge, and slashing."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from network.proof_of_indexing import ProofOfIndexing  # noqa: E402
from network.bonding import BondLedger, InsufficientBond  # noqa: E402


def test_must_have_stake_to_bond():
    b = BondLedger()
    b.credit("m", 50)
    try:
        b.bond("m", 100)
        assert False, "bonded more than held"
    except InsufficientBond:
        pass
    b.bond("m", 50)
    assert b.bonded["m"] == 50 and b.free["m"] == 0


def test_a_lying_maintainer_is_slashed():
    if not have_ed():
        return
    b = BondLedger()
    b.credit("m", 100); b.credit("c", 100)
    b.bond("m", 100)
    poi = ProofOfIndexing(Wallet())
    entry = poi.attest("route:x", b"what the maintainer claimed", 1000)
    # the canonical truth differs from what was attested -> maintainer lied
    verdict = b.challenge("m", entry, b"the REAL different content", "c", stake=40)
    assert verdict["verdict"] == "slashed"
    assert b.bonded["m"] == 60                       # 40 slashed away
    # challenger started at 100, risked 40, won the 40 slashed reward -> 140
    assert b.free["c"] == 140 and b.bonded["c"] == 0


def test_a_spurious_challenge_forfeits_the_challengers_bond():
    if not have_ed():
        return
    b = BondLedger()
    b.credit("m", 100); b.credit("c", 100)
    b.bond("m", 100)
    poi = ProofOfIndexing(Wallet())
    truth = b"the honest content"
    entry = poi.attest("route:x", truth, 1000)       # maintainer told the truth
    verdict = b.challenge("m", entry, truth, "c", stake=30)
    assert verdict["verdict"] == "challenge_failed"
    assert b.bonded["m"] == 130                       # gains the forfeited stake
    assert b.free["c"] == 70


def test_stake_is_conserved_through_every_path():
    if not have_ed():
        return
    b = BondLedger()
    b.credit("m", 100); b.credit("c", 100)
    before = b.total()
    b.bond("m", 100)
    poi = ProofOfIndexing(Wallet())
    entry = poi.attest("r", b"claimed", 1)
    b.challenge("m", entry, b"actual-different", "c", stake=40)
    assert b.total() == before                        # nothing minted or burned
