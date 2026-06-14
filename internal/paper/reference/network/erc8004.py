"""ERC-8004 'Trustless Agents' records — the cross-agent identity surface both
papers point to. The standard defines three registries; a route maintainer maps
onto exactly one trustless agent across all three:

  - Identity:   a portable agent id == the wallet pubkey (follows across contexts)
  - Reputation: signed feedback that accrues from real outcomes
  - Validation: an independent party's signed re-execution / check of a claim

This reference produces and verifies those three record types, each signed by a
real wallet. It demonstrates the binding mechanism — portable id, signed
reputation, independent validation — in runnable form. Binding to the *deployed*
on-chain registries is integration work; the record structure and its signatures
are here and tested.
"""
from __future__ import annotations
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, verify  # noqa: E402


def _canon(d: dict) -> bytes:
    return json.dumps(d, sort_keys=True, separators=(",", ":")).encode()


def identity(wallet: Wallet, agent_id: str) -> dict:
    """Portable Identity record: the agent id bound to the wallet pubkey."""
    body = {"kind": "identity", "agent_id": agent_id, "pubkey": wallet.pub_hex}
    return {**body, "sig": wallet.sign(_canon(body))}


def reputation(rater: Wallet, subject_pubkey: str, score: int, note: str) -> dict:
    """Signed feedback from `rater` about a subject agent."""
    body = {"kind": "reputation", "rater": rater.pub_hex,
            "subject": subject_pubkey, "score": score, "note": note}
    return {**body, "sig": rater.sign(_canon(body))}


def validation(validator: Wallet, claim_hash: str, reproduced: bool) -> dict:
    """An independent validator's signed re-execution result for a claim."""
    body = {"kind": "validation", "validator": validator.pub_hex,
            "claim_hash": claim_hash, "reproduced": reproduced}
    return {**body, "sig": validator.sign(_canon(body))}


def verify_record(rec: dict) -> bool:
    """Each record verifies against the signer field it names."""
    signer = {"identity": "pubkey", "reputation": "rater",
              "validation": "validator"}[rec["kind"]]
    body = {k: v for k, v in rec.items() if k != "sig"}
    return verify(rec[signer], rec["sig"], _canon(body))
