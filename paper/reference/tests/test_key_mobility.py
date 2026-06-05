"""Each test proves one sentence about key mobility and the public boundary."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from layers.key_mobility import Identity, publish, verify_public, LAYERS  # noqa: E402

KNOWN_PRIV = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"


def test_one_key_surfaces_a_value_at_every_layer():
    # The private key moves up and down the stack: it can surface a value at
    # EVERY layer, and each surfacing verifies against the ONE public key.
    w = Wallet()
    idy = Identity(w)
    for layer in LAYERS:
        pub = publish(idy.surface("alice@id", layer))
        assert pub["root"] == w.pub_hex          # the one identity, every altitude
        if have_ed():
            assert verify_public(pub, w.pub_hex)  # the public copy checks out


def test_only_value_copies_cross_the_public_boundary():
    w = Wallet()
    surfaced = Identity(w).surface("balance=42", "cli")
    pub = publish(surfaced)
    assert pub is not surfaced                    # what crosses is a COPY
    pub["value"] = "balance=999"                  # mutate the published copy
    assert surfaced["value"] == "balance=42"      # source untouched -> it was a copy
    assert not verify_public(pub, w.pub_hex)      # tampered copy fails its content hash


def test_the_private_key_never_crosses_the_boundary():
    if not have_ed():
        return
    w = Wallet(KNOWN_PRIV)
    pub = publish(Identity(w).surface("alice@id", "packet"))
    blob = json.dumps(pub)
    assert KNOWN_PRIV not in blob                 # the secret never leaves
    assert w.pub_hex in blob                      # only the public key is exposed
    assert verify_public(pub, w.pub_hex)          # the copy is still publicly checkable


def test_a_foreign_wallet_cannot_forge_a_public_copy():
    if not have_ed():
        return
    w, other = Wallet(), Wallet()
    pub = publish(Identity(w).surface("alice@id", "browser"))
    assert not verify_public(pub, other.pub_hex)  # not signed by `other`
