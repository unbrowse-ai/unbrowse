# The site harness

How the node learns a site's calls across its requests, its script and its wasm from one walk, and makes every value
it can without a browser. The design is in `unbrowse-ai/unbrowse-graph`; this page maps each behaviour to its node and
to where it is built. It restates no rule: read the node.

Decisions: `decide.site-harness`, `decide.coverage-kpi` (Lewis, 12 November 2026).

| Behaviour | Node | Built in | State on this branch |
|---|---|---|---|
| recording | `learn.record` | `unbrowse-node/crates/browser/src/session.rs`, `unbrowse-node/crates/learn/src/recording.rs`, `blobs.rs` | Built: the stack behind each request, every script the page or a worker parsed by hash, each origin's storage at settle and at the end, the sockets. The walk's own probes go by the walk's name and are left out of the script list. |
| lab | `learn.lab` | not built | |
| derivation | `learn.derivation` | `unbrowse-node/crates/learn/src/signing.rs` (`Recipe`), `generated.rs`, `slice.rs` | A digest over parts of the request is fitted and proved on the walk; a program is proposed and proved against every sighting. |
| rung | `learn.rung` | `unbrowse-node/crates/learn/src/rung.rs`, `replay.rs`, `client.rs`, `unbrowse-node/app/src/run.rs` (`made.jsonl`) | Built. |
| reference | `learn.reference` | `unbrowse-node/crates/learn/src/blobs.rs`, `signing.rs` | Script bodies are kept once under their hash. A route still carries the scripts it needs by address; carrying them by hash is not built. |
| isolate | `learn.isolate` | `unbrowse-node/crates/learn/src/sandbox.rs` | The page's scripts run in a runtime with a DOM. The seal (no files, network or processes) is on the security line, not on this branch. |
| lifetime | `learn.lifetime` | not built | |
| proposer | `learn.proposer` | `unbrowse-node/crates/learn/src/generated.rs` | At learn time only; a call asks no model, and `made.jsonl` counts it. |
| matrix | `learn.matrix` | `unbrowse-node/app/src/primitives.rs`, `primitives/matrix.json` | Seventeen rows. |
| door | `learn.door` | `unbrowse-node/crates/learn/src/challenge.rs`, `docs/DOORS.md` | |
| census | `decide.coverage-kpi` | `test-banks/popular-sites/run_bank.py` (`census`), `scripts/harness/bank-run.sh` | Built. |

`learn.door` is proposed, not chosen: it waits on Lewis.

## The rungs

One number per step of a call (`learn.rung`), lowest first. Coverage without a browser (`decide.coverage-kpi`) counts
calls whose highest rung is 3 or lower.

| Rung | Maker | Browser |
|---|---|---|
| 0 | the walk's own values | no |
| 1 | a recipe of standard operations the node computes itself (a recipe field) | no |
| 2 | a program run for the one value (a generated field) | no |
| 3 | the page's whole script, booted in the sandbox (a script field) | no |
| 4 | a page kept open in the browser | yes |
| 5 | the browser making the step | yes |

## Proving a change

Every gate is a command that prints `HARNESS_GREEN <mode>` only when it passed:

```
node scripts/harness/check.mjs self-test
node scripts/harness/check.mjs cargo-test unbrowse-node unbrowse-learn <test name>...
node scripts/harness/check.mjs py-test test-banks/popular-sites test_census
node scripts/harness/check.mjs graph-nodes docs/HARNESS.md
```
