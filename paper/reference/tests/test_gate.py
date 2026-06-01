"""Each test proves one sentence about the gate: no unsigned action crosses."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed, UNSIGNED  # noqa: E402
from layers.descent import SignedDescent  # noqa: E402
from layers.gate import SignedGate, GateReject  # noqa: E402

OPS = {"screen": "click", "browser": "GET /x", "cli": "exec",
       "os": "open", "kernel": "send", "packet": "tls"}


def test_signed_actions_cross_the_gate():
    if not have_ed():
        return
    w = Wallet()
    gate = SignedGate(w.pub_hex)
    for rec in SignedDescent(w).descend("intent", OPS):
        assert gate.admit(rec)
    assert gate.admitted == 6 and gate.rejected == 0


def test_unsigned_action_is_rejected():
    w = Wallet()
    gate = SignedGate(w.pub_hex)
    rec = SignedDescent(w).descend("intent", OPS)[0]
    rec["sig"] = UNSIGNED                       # strip the signature
    assert not gate.admit(rec)
    try:
        gate.enforce(rec)
        assert False, "unsigned action crossed the gate"
    except GateReject:
        pass


def test_action_signed_by_a_foreign_wallet_is_rejected():
    if not have_ed():
        return
    w, foreign = Wallet(), Wallet()
    gate = SignedGate(w.pub_hex)
    rec = SignedDescent(foreign).descend("intent", OPS)[0]
    assert not gate.admit(rec)                  # right shape, wrong root


def test_tampered_op_is_rejected_after_signing():
    if not have_ed():
        return
    w = Wallet()
    gate = SignedGate(w.pub_hex)
    rec = SignedDescent(w).descend("intent", OPS)[0]
    rec["op"] = "DELETE /everything"            # tamper post-signature
    assert not gate.admit(rec)
    assert gate.rejected == 1 and gate.admitted == 0
