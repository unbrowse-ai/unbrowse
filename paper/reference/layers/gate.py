"""The signed-action gate: no unsigned action crosses, at any layer, ever.

*Internal APIs Were Not All You Needed* states the seal as a hard invariant: an
action is admitted at a layer only if it carries a valid signature from the
wallet root that the layer is bound to. This is the runtime counterpart of the
descent — descent *produces* the signed chain; the gate *enforces* it at the
boundary of every layer before any effect (click/write/send) is allowed.

`SignedGate.admit(rec)` returns True only when the record's signature verifies
against the gate's bound root over the record's canonical bytes. Everything else
— missing signature, wrong key, tampered op — is rejected and counted. The gate
keeps an honest tally so a test can assert that zero unsigned actions were ever
admitted.
"""
from __future__ import annotations
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import verify, UNSIGNED  # noqa: E402
from layers.descent import _canon  # the SAME canonical form the descent signs  # noqa: E402


class GateReject(Exception):
    """Raised when an unsigned or invalid action tries to cross the gate."""


class SignedGate:
    """Bound to one wallet root. Admits only actions it can verify."""

    def __init__(self, bound_root: str):
        self.bound_root = bound_root
        self.admitted = 0
        self.rejected = 0

    def admit(self, rec: dict) -> bool:
        sig = rec.get("sig", UNSIGNED)
        if sig == UNSIGNED or rec.get("root") != self.bound_root \
                or not verify(self.bound_root, sig, _canon(rec)):
            self.rejected += 1
            return False
        self.admitted += 1
        return True

    def enforce(self, rec: dict) -> dict:
        """Admit or raise — the path an effect-producing call must pass through."""
        if not self.admit(rec):
            raise GateReject(f"unsigned/invalid action at layer {rec.get('layer')!r}")
        return rec
