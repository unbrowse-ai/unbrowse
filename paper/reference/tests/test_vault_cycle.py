"""Each test proves one sentence about the vault cycle (staking by abiding)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from network.vault_cycle import distribute, abiding_weights  # noqa: E402


def test_fee_is_split_pro_rata_to_abiding():
    # equal balance, equal duration -> equal split
    d = distribute(100, {"a": (10, 5), "b": (10, 5)})
    assert d == {"a": 50, "b": 50}


def test_distribution_is_conservative():
    d = distribute(1000, {"a": (3, 7), "b": (11, 2), "c": (5, 5)})
    assert sum(d.values()) == 1000                     # nothing minted or lost


def test_holding_longer_or_larger_earns_more():
    w = abiding_weights({"short": (10, 1), "long": (10, 9)})
    assert w["long"] > w["short"]                      # duration matters
    d = distribute(100, {"short": (10, 1), "long": (10, 9)})
    assert d["long"] > d["short"]


def test_no_holding_earns_nothing():
    d = distribute(100, {"holder": (10, 5), "freeloader": (0, 100)})
    assert d.get("freeloader", 0) == 0 and d["holder"] == 100
