"""Each test proves one sentence about FROST-style t-of-n threshold finalisation:
t signers finalise, t-1 cannot, no single party forges."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from network.frost import finalize, reconstruct, split  # noqa: E402

SECRET = 0xC0FFEE_1234567890_ABCDEF
# t-1 = 2 fixed higher coefficients (passed in -> deterministic, no randomness)
COEFFS = [0x1111_2222_3333, 0x4444_5555_6666]
T, N = 3, 5


def test_t_distinct_signers_reconstruct_the_secret():
    shares = split(SECRET, T, N, COEFFS)
    assert reconstruct(shares[:T]) == SECRET            # exactly t suffices
    assert reconstruct(shares) == SECRET                # all n agree


def test_t_minus_1_signers_cannot_recover_the_secret():
    shares = split(SECRET, T, N, COEFFS)
    assert reconstruct(shares[: T - 1]) != SECRET       # a quorum short reveals nothing of it


def test_finalize_requires_a_quorum_of_t():
    shares = split(SECRET, T, N, COEFFS)
    assert finalize(shares[: T - 1], SECRET, T) is False  # t-1 cannot finalise
    assert finalize(shares[:T], SECRET, T) is True        # t can
    assert finalize(shares, SECRET, T) is True            # n can


def test_duplicate_signers_do_not_count_toward_the_quorum():
    shares = split(SECRET, T, N, COEFFS)
    one = shares[0]
    assert finalize([one, one, one], SECRET, T) is False  # one signer cannot fake t


def test_no_single_party_can_forge_the_finalisation():
    shares = split(SECRET, T, N, COEFFS)
    # a lone signer, even reusing its share, never reconstructs the secret
    assert reconstruct([shares[0]]) != SECRET
    assert finalize([shares[0]], SECRET, T) is False


def test_the_split_is_deterministic_same_coeffs_same_shares():
    a = split(SECRET, T, N, COEFFS)
    b = split(SECRET, T, N, COEFFS)
    assert a == b                                         # provable, not random
