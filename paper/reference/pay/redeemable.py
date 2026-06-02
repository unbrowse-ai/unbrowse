"""Redeemable wallet that pays API tolls under the hood — x402 hidden as a
technology (sp-toll node/verb/seal + sp-unbrowse root/seal atoms).

The toll economy meters access over x402 (HTTP 402 Payment Required, RFC 9110):
an endpoint answers 402 with a challenge naming the price and the payee; a request
clears it by carrying a signed payment proof. That is the right MECHANISM and the
wrong THING to show a user. So we wrap it: the user sees a Privy wallet with a
redeemable balance — "credits" they top up and spend — and never the letters x402.

`PrivyWallet` is the audience-native surface (address, balance, redeem, statement).
The x402 settlement (`_settle_x402`) is private: on a 402 the wrapper checks the
balance, signs the challenge with the wallet's real Ed25519 key (the signature IS
the proof — sp-unbrowse seal), debits credits, and retries with the proof attached.
The caller calls `pay()` and gets the result; the toll just works, invisibly.
"""
from __future__ import annotations
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, verify  # noqa: E402  real ed25519 — the payment proof is a real signature

# Redeemable vouchers -> credit units (e.g. USDC cents). A real deployment mints
# these against a fiat/USDC top-up; here they are the redeemable seed.
_VOUCHERS = {"WELCOME10": 1000, "TOPUP50": 5000}


class InsufficientCredits(Exception):
    """User-facing: speaks of credits, never of x402."""


def _challenge_bytes(challenge: dict) -> bytes:
    core = {k: challenge[k] for k in ("amount", "pay_to", "route")}
    return json.dumps(core, sort_keys=True, separators=(",", ":")).encode()


def _settle_x402(wallet: Wallet, challenge: dict) -> dict:
    """PRIVATE — the hidden technology. Sign the 402 challenge into a payment proof.

    This is the only place the protocol lives; nothing it returns is shown to the
    user. The signature over the challenge IS the proof the toll was paid.
    """
    sig = wallet.sign(_challenge_bytes(challenge))
    return {"x-payment": sig, "payer": wallet.pub_hex, "pay_to": challenge["pay_to"]}


def _verify_payment(proof: dict, challenge: dict) -> bool:
    """A facilitator/endpoint checks the proof clears the challenge (internal)."""
    return verify(proof["payer"], proof["x-payment"], _challenge_bytes(challenge))


class PrivyWallet:
    """The audience-native wrapper. The user sees credits; never a toll protocol."""

    def __init__(self, balance: int = 0):
        self._wallet = Wallet()          # Privy custodies this key (here: in-process)
        self.balance = balance           # redeemable credit units

    @property
    def address(self) -> str:
        return self._wallet.pub_hex

    def redeem(self, code: str) -> int:
        """Redeem a voucher code into spendable credits. Returns the new balance."""
        amount = _VOUCHERS.get(code)
        if amount is None:
            raise ValueError(f"'{code}' is not a valid redemption code")
        self.balance += amount
        return self.balance

    def statement(self) -> str:
        """The human-facing summary. No protocol jargon ever appears here."""
        return f"{self.balance} credits available · wallet {self.address[:8]}…"


def pay(endpoint, wallet: PrivyWallet, intent: str = "") -> dict:
    """Call `endpoint`, auto-clearing any toll out of the wallet's credits.

    `endpoint(payment)` is the metered access: called once with payment=None; if it
    answers 402 it returns {"status": 402, "challenge": {amount, pay_to, route}};
    we settle the toll under the hood (sign + debit) and call again with the proof.
    The caller never sees, names, or constructs an x402 payment.
    """
    resp = endpoint(None)
    if resp.get("status") != 402:
        return resp                              # free rung — quote cost nothing
    challenge = resp["challenge"]
    if wallet.balance < challenge["amount"]:
        raise InsufficientCredits(
            f"need {challenge['amount']} credits, only {wallet.balance} available — top up to continue")
    proof = _settle_x402(wallet._wallet, challenge)   # hidden technology
    wallet.balance -= challenge["amount"]             # debit credits
    return endpoint(proof)                            # retry with the toll paid
