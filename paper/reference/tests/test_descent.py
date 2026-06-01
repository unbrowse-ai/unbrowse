"""Each test proves one sentence about signed descent through every layer."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from layers.descent import SignedDescent, verify_descent, LAYERS  # noqa: E402

OPS = {"screen": "click(412,300)", "browser": "GET /api/v2/cart",
       "cli": "unbrowse execute cart.add", "os": "connect(fd=7)",
       "kernel": "sendmsg(sk)", "packet": "TLS1.3 -> 1.2.3.4:443"}


def test_every_layer_descends_from_one_root():
    w = Wallet()
    chain = SignedDescent(w).descend("add to cart", OPS)
    assert [r["layer"] for r in chain] == list(LAYERS)   # full stack touched
    assert all(r["root"] == w.pub_hex for r in chain)    # ONE identity, every layer
    if have_ed():
        assert verify_descent(chain, w.pub_hex)          # the whole descent verifies


def test_a_different_wallet_cannot_own_the_descent():
    if not have_ed():
        return
    w, other = Wallet(), Wallet()
    chain = SignedDescent(w).descend("add to cart", OPS)
    assert not verify_descent(chain, other.pub_hex)      # not your descent


def test_tampering_one_layer_breaks_the_chain():
    if not have_ed():
        return
    w = Wallet()
    chain = SignedDescent(w).descend("add to cart", OPS)
    chain[3]["op"] = "connect(fd=evil)"                  # tamper the OS layer
    assert not verify_descent(chain, w.pub_hex)          # break is detected


def test_reordering_layers_breaks_the_descent():
    if not have_ed():
        return
    w = Wallet()
    chain = SignedDescent(w).descend("add to cart", OPS)
    chain[2], chain[3] = chain[3], chain[2]              # swap CLI <-> OS
    assert not verify_descent(chain, w.pub_hex)          # parent links break
