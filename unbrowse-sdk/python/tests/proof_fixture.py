"""The node's answer to ``/v1/node/proof``, for the fake nodes: the proof for the token whose key the asker names, as an
agent's (``agents``) or the owner's (``owner``); nothing for a key it doesn't hold. Not a test file."""

from urllib.parse import parse_qs, urlparse

from unbrowse._proof import node_proof, token_key


def proof_answer(path, port, agents=(), owner=None):
    u = urlparse(path)
    if u.path != "/v1/node/proof":
        return None
    q = parse_qs(u.query)
    challenge = bytes.fromhex((q.get("challenge") or [""])[0])
    key = (q.get("key") or [""])[0]
    for t in agents:
        if token_key(t) == key:
            return {"agents": [node_proof(t, port, challenge)]}
    if owner and token_key(owner) == key:
        return {"agents": [], "owner": node_proof(owner, port, challenge)}
    return {"agents": []}
