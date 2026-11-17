# unbrowse-learn

Route learning. The node's browser walks a page once; this crate reads the walk, finds where every value in every
request came from, keeps the call that answers the goal, and replays it as plain HTTP with new inputs.

It links the browser engine (`agent-browser-core` in [`unbrowse-browser/core`](../../../unbrowse-browser/core)) by
path, so a walk is a library call, not a daemon. [AGENTS.md](../../../AGENTS.md) explains the pipeline this crate
implements: mint, walk, trace, route, call.

## Modules

| Stage | Modules | What they do |
|---|---|---|
| Walk | `walk`, `mint`, `session` | Walk a page in the engine and read the capture log; pass the site's front door so plain calls carry the session it issues |
| Trace | `trace`, `slots`, `provenance`, `identity` | The walk as HTTP exchanges plus what was typed; every value a request carries, and where it came from (an earlier response, a cookie, the caller) |
| Route | `graph`, `schema`, `page`, `judge` | The dependency graph from the page to the target call; value-free schemas of its answers; a page as an answer when the goal is the page |
| Call | `client`, `http`, `replay`, `ledger`, `verify` | Replay over a Chrome-shaped TLS and HTTP/2 transport; a clean re-run in a fresh session; what a call did to the site and whether it may run again |
| Sessions | `site`, `challenge`, `robots`, `decision` | The site's door, a page that asks for a person (shown to the agent as a picture and driven one step at a time), robots.txt policy, checks on automated decisions |
| Snapshots | `snapshot` (`snapshot.js`) | The page's interactive elements, indexed for an agent to drive |
| Egress | `egress`, `proxy` | Where a call may land: a public name that resolves inside the network is refused; the browser's own loads go through a loopback SOCKS5 proxy that resolves each name through the same rule |

## Rules the code follows

- **Gates are read from the walk, never named.** The door is the stretch of the walk from the first page refused or
  served by another site to the site's own page (`Trace::door`). No host lists anywhere in this crate.
- **Secrets are references.** A value typed into a password, code or card field is marked secret by the browser and
  becomes a secret input, never a recorded value.
- **Recorded statuses are expected statuses.** Only an unexpected status fails a call.
- **The browser resolves through the node's rule, not its own.** Every browser the node launches (`mint`, and the
  CLI `browse` drives) is given a loopback SOCKS5 proxy (`proxy`) that resolves each name through `egress` and refuses
  a public name that answers inside the network before it connects. It is a proxy and not the engine's interception
  because a tunnel leaves the browser's TLS handshake intact, which is what the door reads.

## Tests

```bash
cargo test -p unbrowse-learn
```

`tests/` runs the learner against a local fake shop (`tests/common/shop.rs`): learn a flow, then replay it.
`examples/` are probes run by hand with a built browser: `site_probe` (any site), `tls_probe`, `mint_probe`, and `shop`
(the test shop, to record a flow).
`assets/` holds the measurements behind the transport and the door: Chrome's ClientHello, challenge notes, probes.

The TLS transport needs BoringSSL with Chrome's extensions: run `sh scripts/apply-tls-patch.sh` in `unbrowse-node`
first.

## Licence

[Apache-2.0](../../../LICENSE).
