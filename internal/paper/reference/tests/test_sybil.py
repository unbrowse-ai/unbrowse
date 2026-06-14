"""Each test proves one sentence about Sybil resistance (split-invariance)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from network.sybil import attribute, influence_of, split_identity, gain_from_split  # noqa: E402


def test_influence_is_stake_weighted_and_sums_to_one():
    shares = attribute({"a": 30, "b": 70})
    assert abs(shares["a"] - 0.3) < 1e-9 and abs(shares["b"] - 0.7) < 1e-9
    assert abs(sum(shares.values()) - 1.0) < 1e-9


def test_splitting_an_identity_yields_no_gain():
    stakes = {"attacker": 40, "honest": 60}
    after = split_identity(stakes, "attacker", [f"sybil{i}" for i in range(10)])
    assert sum(after.values()) == 100                    # stake conserved
    assert abs(gain_from_split(stakes, "attacker", [f"s{i}" for i in range(10)])) < 1e-9


def test_more_influence_requires_more_stake_not_more_identities():
    base = influence_of({"a": 10, "b": 90}, {"a"})
    # a thousand free identities, zero added stake -> no influence gain
    flooded = {"b": 90, "a": 10}
    for i in range(1000):
        flooded[f"free{i}"] = 0
    assert abs(influence_of(flooded, {"a"}) - base) < 1e-9
    # actually buying stake DOES move influence (cost is the only lever)
    assert influence_of({"a": 50, "b": 90}, {"a"}) > base


def test_zero_total_stake_grants_no_influence():
    assert attribute({"a": 0, "b": 0}) == {}
