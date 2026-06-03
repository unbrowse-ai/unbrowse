"""A content-addressed value is true forever, derived once and never recomputed --
unless the value includes time, in which case its pointer changes each moment and it
re-resolves; dependent recompute is automatic, not a cascade you build.

The recompute boundary, proven on the sha256 substrate (mirrors the covenant
substrate's recompute_invariance test and src/values/resolution-ledger.ts). A value is
addressed by the sha256 of its bytes. A memo keyed on that pointer HITS forever while
the value is unchanged (timeless = true forever), and MISSES only when the value's
bytes change. The sharpest miss is time-in-the-value: the pointer flips every moment,
so the derivation recomputes each time -- "unless the promise included time itself."

The key economic point: dependent recompute needs no DAG walk. A value keyed on
another value's pointer is, by construction, a DIFFERENT key the instant that pointer
changes -- so a changed input invalidates everything addressed through it
automatically, because correctness falls out of the addressing, not a clock or a
manual flush.
"""
from __future__ import annotations
import hashlib
from typing import Callable


def pointer(value: bytes) -> str:
    """The content address: the same bytes resolve to the same pointer, forever, in
    every process."""
    return hashlib.sha256(value).hexdigest()


class Memo:
    """Derive-once-per-content-address memo. `computes` counts real derivations: a
    HIT serves the prior output without recomputing; a MISS (the value's pointer
    changed) recomputes once and re-pins."""

    def __init__(self) -> None:
        self._slots: dict[str, tuple[str, object]] = {}
        self.computes = 0

    def get_or_compute(self, key: str, value: bytes, derive: Callable[[bytes], object]) -> object:
        p = pointer(value)
        slot = self._slots.get(key)
        if slot is not None and slot[0] == p:
            return slot[1]              # HIT -- true forever, no recompute
        self.computes += 1              # MISS -- value (hence pointer) changed -> recompute
        out = derive(value)
        self._slots[key] = (p, out)
        return out
