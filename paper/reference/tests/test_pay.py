"""Each test proves one sentence of the hidden-x402 redeemable wallet
(sp-toll node/verb/seal, sp-unbrowse root/seal; arXiv:2604.00694 + x402)."""
import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import have_ed  # noqa: E402
from pay import redeemable  # noqa: E402
from pay.redeemable import (  # noqa: E402
    PrivyWallet, InsufficientCredits, pay, _verify_payment, _settle_x402)


def _toll_endpoint(amount=300, pay_to="discoverer.sol", route="api.site.com/items"):
    """A metered endpoint: 402 until a valid payment proof clears the challenge."""
    challenge = {"amount": amount, "pay_to": pay_to, "route": route}
    def endpoint(payment):
        if payment is None:
            return {"status": 402, "challenge": challenge}
        if _verify_payment(payment, challenge):
            return {"status": 200, "body": {"items": [1, 2, 3]}}
        return {"status": 402, "challenge": challenge}  # bad proof -> still gated
    return endpoint


def test_402_triggers_automatic_payment_and_debits_credits():
    w = PrivyWallet(balance=1000)
    resp = pay(_toll_endpoint(amount=300), w)        # caller never mentions x402
    assert resp["status"] == 200 and resp["body"]["items"] == [1, 2, 3]
    assert w.balance == 700                           # toll debited from credits


def test_payment_proof_is_a_real_wallet_signature():
    if not have_ed():
        return
    w = PrivyWallet(balance=1000)
    challenge = {"amount": 300, "pay_to": "discoverer.sol", "route": "r"}
    proof = _settle_x402(w._wallet, challenge)
    assert _verify_payment(proof, challenge)          # the signature IS the proof
    assert proof["payer"] == w.address
    # a different challenge does not verify against this proof (no replay across tolls)
    assert not _verify_payment(proof, {**challenge, "amount": 1})


def test_x402_is_hidden_from_the_user_facing_surface():
    w = PrivyWallet(balance=1000)
    # public attributes/methods of the wallet must not name the technology
    public = [n for n in dir(w) if not n.startswith("_")]
    for name in public:
        low = name.lower()
        assert "x402" not in low and "402" not in low and "payment" not in low, name
    # the human statement and the user-facing error must speak credits, not x402
    text = w.statement()
    try:
        pay(_toll_endpoint(amount=99999), PrivyWallet(balance=1))
    except InsufficientCredits as e:
        text += " " + str(e)
    for forbidden in ("x402", "402", "x-payment", "payment proof"):
        assert forbidden not in text.lower(), forbidden
    # but the technology IS really used under the hood (not faked away)
    assert "x402" in inspect.getsource(redeemable)    # the mechanism exists, privately


def test_redeemable_topup_then_spend():
    w = PrivyWallet(balance=0)
    assert w.redeem("WELCOME10") == 1000              # voucher -> credits
    resp = pay(_toll_endpoint(amount=400), w)
    assert resp["status"] == 200 and w.balance == 600


def test_invalid_code_is_rejected():
    w = PrivyWallet()
    try:
        w.redeem("NOPE")
        assert False, "invalid code redeemed"
    except ValueError:
        pass


def test_insufficient_credits_fails_honestly_no_free_access():
    w = PrivyWallet(balance=100)
    try:
        pay(_toll_endpoint(amount=300), w)
        assert False, "got access without paying the toll"
    except InsufficientCredits:
        pass
    assert w.balance == 100                            # nothing debited, no access


def test_free_endpoint_costs_nothing():
    w = PrivyWallet(balance=500)
    def free(payment):
        return {"status": 200, "body": "ok"}
    resp = pay(free, w)
    assert resp["status"] == 200 and w.balance == 500  # quote was free, no toll


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(fns)} green")
    sys.exit(0 if passed == len(fns) else 1)
