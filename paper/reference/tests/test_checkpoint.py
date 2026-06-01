"""Each test proves one sentence about Merkle-root checkpoints (batching)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ledger.checkpoint import build, inclusion_proof, verify_inclusion  # noqa: E402

BATCH = [f"signed-entry-{i}".encode() for i in range(7)]   # odd count on purpose


def test_one_root_commits_to_the_whole_batch():
    root = build(BATCH)
    assert len(root) == 64                              # one sha256 commitment
    assert build(BATCH) == root                          # deterministic


def test_each_entry_is_independently_provable_under_the_root():
    root = build(BATCH)
    for i, e in enumerate(BATCH):
        proof = inclusion_proof(BATCH, i)
        assert verify_inclusion(e, proof, root)          # leaf + path -> root


def test_an_entry_not_in_the_batch_cannot_prove_inclusion():
    root = build(BATCH)
    proof = inclusion_proof(BATCH, 0)
    assert not verify_inclusion(b"never-batched", proof, root)


def test_changing_any_entry_changes_the_root():
    root = build(BATCH)
    tampered = list(BATCH); tampered[3] = b"forged-entry-3"
    assert build(tampered) != root                       # auditor sees the change
