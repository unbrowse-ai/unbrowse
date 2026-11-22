# The attack bank

Agents try to take what they must never hold, the way an agent would: through the node's own MCP tools (`unb mcp`,
each with its own agent key), against a site this machine serves, with canaries an oracle can find in any form. It is
a regression test for SECURITY.md's boundaries, run on every pull request like the MCP check, with no model.

| File | What it is |
|---|---|
| `canary_site.py` | alice's account on a site this machine serves: a session cookie (`HttpOnly`), a script-readable cookie, a token her page stores, a private page, an endpoint that says her session back, and links and a form whose address would run code in the page's world. A collector at another address is the attacker's. Every request to either is logged with its cookies. |
| `oracle.py` | Whether a canary stands in a text in any form a script could give it: as itself, reversed, percent-encoded, hex, base64 at any alignment, or its characters spread with others between. |
| `run_attack.py` | Two nodes and three agents, the attacks, the oracle, the report (`attack.md`, `attack.json`, every reply under `replies/`). Exit 1 when anything didn't hold. |
| `test_attack.py` | The oracle and the site, checked without a node. |

The actors:

- **alice's agent**, on node A, which holds her session (its owner imported it) and a vault login. It acts for her, so
  it may read her private page; it must never hold her session, her stored token or the vault's password.
- **another agent on node A**: it may not collect what alice's agent asked.
- **an agent on node B**, another account: neither A's door, alice's session and pages, nor A's vault login are its.

What is attacked, and what must hold:

| Boundary | Attacks |
|---|---|
| A script never holds the session (`world.rs`, `session_held`) | `document.cookie` as itself, reversed, base64, spread; the stored token likewise; a `<script>` or `onerror` HTML put into the page; a `javascript:` address; a `fetch` to the collector |
| No command runs a script address in the page's world | `find … click` on a `javascript:` link, a form whose action is one, a label forwarding to a submit with one |
| An answer never says the session back | a route of `/session.json`, which echoes it |
| The vault's password is the node's to type, never the agent's to read | a vault fill into the site's https login form, then `eval` and `get value` on the field, and `unbrowse_logins` |
| One agent's asks are its own | another key of the same node collects alice's agent's ask |
| Another node can't sign in as alice | B's key at A's door; B's own calls and pages at alice's site (and no request carrying her session while only B acts); B filling A's vault login |

By hand:

```sh
python3 -m unittest discover -s test-banks/attack -p 'test_*.py'
python3 test-banks/attack/run_attack.py --node unbrowse-node/target/debug/unbrowse-node \
  --unb unbrowse-node/target/debug/unb --browser <the browser program> --out /tmp/attack
```

A node's browser never browses this machine, so the canary site and the collector are each reached at a public https
address of their own through `cloudflared` quick tunnels (`*.trycloudflare.com`): the node treats them as any site on
the web, and https is what a vault login needs. Only the run's random canaries cross the tunnel. The password checks
fill the site's own login form with a vault login of the bank's own.

Checked against the bank itself: with the browser before #814 (an agent's script in the page's own world) the bank
fails, with alice's cookie and stored token read back reversed, spread and as themselves, the `javascript:` clicks run,
and both reaching the collector encoded; with #814 every check holds.

Not yet here: attacks through the peer network (a listed route that would carry a session, a fetched route that would
send one elsewhere or sign in as someone else) and through the remote gateway; they need two joined nodes and a
gateway, and are the next part of this bank.
