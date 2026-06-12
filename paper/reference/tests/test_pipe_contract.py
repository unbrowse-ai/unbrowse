import sys

from pipes.pipe_contract import PipeRuntime, approval_token, cid


def test_pipe_payload_is_content_addressed():
    runtime = PipeRuntime()
    source = runtime.produce((sys.executable, "-c", "print('pipe payload')"))

    assert source.startswith("sha256:")
    assert runtime.blobs[source] == b"pipe payload\n"
    assert cid(runtime.blobs[source]) == source


def test_pipe_fails_closed_without_approval():
    runtime = PipeRuntime()
    source = runtime.produce((sys.executable, "-c", "print('secret')"))

    assert runtime.pipe(source, "downstream:B", None) is None
    assert runtime.ledger[-1] == {"event": "denied", "cid": source, "target": "downstream:B"}


def test_approved_release_is_reproducible():
    runtime = PipeRuntime()
    source = runtime.produce((sys.executable, "-c", "print('approved')"))
    token = approval_token(source, "downstream:B")

    released = runtime.pipe(source, "downstream:B", token)

    assert released == b"approved\n"
    assert cid(released) == source
    assert runtime.ledger[-1] == {"event": "piped", "cid": source, "target": "downstream:B"}


def test_identical_input_hits_cache():
    runtime = PipeRuntime()
    command = (sys.executable, "-c", "print('cache me')")

    first = runtime.produce(command)
    second = runtime.produce(command)

    assert second == first
    assert runtime.runs == 1
