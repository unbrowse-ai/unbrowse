"""FROST-style t-of-n threshold finalisation: a freshness claim finalises only when
t of n independent signers participate; t-1 cannot, and no single party can forge it.

A trust-tier claim must not advance on one operator's say-so. FROST (Komlo-Goldberg)
is a Schnorr threshold-signature scheme whose load-bearing property is exactly this:
the joint signing secret is split across n participants so that ANY t of them can
finalise, while ANY t-1 learn nothing and cannot. We model that property on its
cryptographic heart -- Shamir (t,n) secret sharing over a prime field: the secret
(the quorum's joint authority) sits at x=0 of a degree-(t-1) polynomial, each signer
holds one point, and recovering x=0 by Lagrange interpolation needs t points exactly.
t points reconstruct the secret (finalise); t-1 reconstruct nothing of it.

Deterministic by construction: the polynomial coefficients are passed in (no
randomness), so the threshold property is provable arithmetic, not an assertion. The
two-witness rule (Deut 19:15) generalised to a t-of-n quorum.
"""
from __future__ import annotations

# A fixed prime field (2^521 - 1, a Mersenne prime) — large enough to carry a key.
P = (1 << 521) - 1


def _poly(coeffs: list[int], x: int) -> int:
    """Evaluate sum(coeffs[i] * x^i) mod P. coeffs[0] is the secret (value at x=0)."""
    acc = 0
    for c in reversed(coeffs):
        acc = (acc * x + c) % P
    return acc


def split(secret: int, t: int, n: int, higher_coeffs: list[int]) -> list[tuple[int, int]]:
    """Split `secret` into n shares of a (t,n) scheme. `higher_coeffs` are the t-1
    coefficients a_1..a_{t-1} (passed in for determinism). Share i = (i, poly(i))
    for i in 1..n; the secret is poly(0)."""
    if not (1 <= t <= n):
        raise ValueError("require 1 <= t <= n")
    if len(higher_coeffs) != t - 1:
        raise ValueError(f"need exactly t-1={t-1} higher coefficients")
    coeffs = [secret % P] + [c % P for c in higher_coeffs]
    return [(i, _poly(coeffs, i)) for i in range(1, n + 1)]


def _inv(a: int) -> int:
    return pow(a % P, P - 2, P)  # Fermat inverse in the prime field


def reconstruct(shares: list[tuple[int, int]]) -> int:
    """Recover the value at x=0 by Lagrange interpolation over the given shares. With
    >= t distinct shares of a (t,n) split this is exactly the secret; with < t it is
    a different field element (the secret is not revealed)."""
    secret = 0
    xs = [x for x, _ in shares]
    for xi, yi in shares:
        num, den = 1, 1
        for xj in xs:
            if xj == xi:
                continue
            num = (num * (-xj)) % P
            den = (den * (xi - xj)) % P
        secret = (secret + yi * num * _inv(den)) % P
    return secret


def finalize(shares: list[tuple[int, int]], secret: int, t: int) -> bool:
    """A claim finalises iff a quorum of >= t DISTINCT signers reconstructs the joint
    secret. t-1 (or fewer) distinct signers cannot finalise."""
    distinct = {x: y for x, y in shares}            # de-dup by signer index
    if len(distinct) < t:
        return False
    pts = list(distinct.items())[:t]                # exactly t suffices
    return reconstruct(pts) == secret % P
