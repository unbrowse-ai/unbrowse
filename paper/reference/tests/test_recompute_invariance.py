"""Each test proves one sentence about the recompute boundary: a content-addressed
value is true forever (never recomputed) unless time is part of the value, and
dependent recompute is automatic, not a cascade."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ledger.recompute import Memo, pointer  # noqa: E402


def test_a_timeless_value_is_true_forever_derived_once():
    memo = Memo()
    value = b'{"claim":"the route resolves","witness":"94/94"}'
    for _ in range(100):
        out = memo.get_or_compute("claim", value, lambda v: f"derived:{len(v)}")
        assert out == f"derived:{len(value)}"
    assert memo.computes == 1   # unchanged value -> ONE computation, ever


def test_same_bytes_resolve_to_the_same_pointer_every_time():
    a = pointer(b"proof-of-reuse")
    b = pointer(b"proof-of-reuse")
    assert a == b                                  # true forever
    assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)


def test_a_value_that_includes_time_recomputes_each_moment():
    memo = Memo()
    for i in range(5):
        timed = b'{"claim":"now","at":"2026-06-04T00:00:0%dZ"}' % i
        memo.get_or_compute("timed", timed, lambda v: f"derived:{len(v)}")
    assert memo.computes == 5   # time in the value busts the cache every moment


def test_changing_the_value_recomputes_exactly_once_then_holds():
    memo = Memo()
    for _ in range(10):
        memo.get_or_compute("k", b"v1", lambda v: v)
    memo.get_or_compute("k", b"v2", lambda v: v)   # the value changed once
    for _ in range(10):
        memo.get_or_compute("k", b"v2", lambda v: v)
    assert memo.computes == 2   # one derivation per distinct value, no churn


def test_dependent_recompute_is_automatic_no_cascade():
    # A downstream value keyed on an upstream value's POINTER. When the upstream
    # changes, its pointer changes, so the downstream's key changes -> the downstream
    # misses and recomputes WITHOUT any explicit dependency-graph walk. Content
    # addressing IS the invalidation.
    up = Memo()
    down = Memo()

    def resolve(upstream_value: bytes) -> int:
        up.get_or_compute("up", upstream_value, lambda v: v)
        up_ptr = pointer(upstream_value)            # downstream is keyed on it
        down.get_or_compute("down:" + up_ptr, upstream_value, lambda v: len(v))
        return down.computes

    for _ in range(5):
        resolve(b"upstream-A")                       # stable upstream
    assert down.computes == 1                        # downstream derived once
    resolve(b"upstream-B")                           # upstream changed -> new pointer
    assert down.computes == 2                        # downstream auto-recomputed, no cascade code
