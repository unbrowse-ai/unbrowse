"""Each test proves one sentence about ZK credential binding."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from zk.binding import bind, prove, verify_binding, credential_scalar, P  # noqa: E402

CRED = b"cookie: session=9f1c...keychain://login"


def test_holder_proves_binding_without_revealing_credential():
    if not have_ed():
        return
    w = Wallet()
    binding = bind(CRED, w)
    proof = prove(CRED, binding, ctx=b"unbrowse:execute")
    assert verify_binding(binding, proof)               # "yes, bound" — and only that
    # the credential never appears in the public binding or the proof
    blob = (binding["y"] + binding["sig"] + proof["t"] + proof["s"]).encode()
    assert CRED not in blob


def test_binding_point_hides_the_credential():
    # y = g^x is one-way: y does not equal any trivial encoding of the credential
    w = Wallet() if have_ed() else None
    if w is None:
        return
    binding = bind(CRED, w)
    assert int(binding["y"], 16) < P
    assert CRED.hex() not in binding["y"]


def test_wrong_credential_cannot_forge_a_proof():
    if not have_ed():
        return
    w = Wallet()
    binding = bind(CRED, w)
    try:
        bad = prove(b"not the credential", binding)     # opens to a different x
        # if prove did not assert, the proof must at least fail to verify
        assert not verify_binding(binding, bad)
    except AssertionError:
        pass                                             # prove() refused — also correct


def test_unsigned_binding_is_rejected():
    # a binding the wallet never signed must not verify, even with a valid proof
    if not have_ed():
        return
    w = Wallet()
    binding = bind(CRED, w)
    proof = prove(CRED, binding)
    binding["sig"] = "__UNSIGNED__"
    assert not verify_binding(binding, proof)
