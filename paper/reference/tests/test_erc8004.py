"""Each test proves one sentence about the ERC-8004 trustless-agent records."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from network.erc8004 import identity, reputation, validation, verify_record  # noqa: E402


def test_identity_is_portable_and_signed():
    if not have_ed():
        return
    w = Wallet()
    rec = identity(w, agent_id="maintainer:42")
    assert rec["pubkey"] == w.pub_hex          # the id IS the portable pubkey
    assert verify_record(rec)


def test_reputation_is_signed_feedback_from_a_real_rater():
    if not have_ed():
        return
    rater, subject = Wallet(), Wallet()
    rec = reputation(rater, subject.pub_hex, score=5, note="route stayed fresh")
    assert verify_record(rec)


def test_validation_is_an_independent_reexecution_record():
    if not have_ed():
        return
    validator = Wallet()
    rec = validation(validator, claim_hash="abcd1234", reproduced=True)
    assert verify_record(rec) and rec["reproduced"] is True


def test_forged_record_does_not_verify():
    if not have_ed():
        return
    w, foreign = Wallet(), Wallet()
    rec = identity(w, "maintainer:42")
    rec["pubkey"] = foreign.pub_hex            # claim a different identity
    assert not verify_record(rec)
