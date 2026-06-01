"""Each test proves one sentence about proof of indexing (freshness primitive)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from network.proof_of_indexing import ProofOfIndexing, verify_poi, is_fresh  # noqa: E402


def test_attestation_is_reverifiable_against_real_content():
    if not have_ed():
        return
    poi = ProofOfIndexing(Wallet())
    content = b"<html>fresh route body @ t=1000</html>"
    e = poi.attest("route:cart.add", content, indexed_at=1000)
    assert verify_poi(e, content)                       # re-derivation confirms it


def test_false_content_fails_reverification():
    if not have_ed():
        return
    poi = ProofOfIndexing(Wallet())
    e = poi.attest("route:cart.add", b"real body", indexed_at=1000)
    assert not verify_poi(e, b"a DIFFERENT body")        # hash mismatch caught


def test_freshness_window():
    poi = ProofOfIndexing(Wallet())
    e = poi.attest("route:x", b"body", indexed_at=1000)
    assert is_fresh(e, now=1500, ttl=600)                # within window
    assert not is_fresh(e, now=2000, ttl=600)            # stale


def test_attestations_are_hash_chained():
    if not have_ed():
        return
    poi = ProofOfIndexing(Wallet())
    a = poi.attest("r", b"v0", 1)
    b = poi.attest("r", b"v1", 2)
    assert b["prev"] != "0" * 64 and a["prev"] == "0" * 64   # b chains onto a
