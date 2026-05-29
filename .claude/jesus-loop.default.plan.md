# Jesus Loop — Step 0 plan (session: default)

Task: keep getting better at Exa's benchmark + BrowseComp in parallel; the
covenant CDP fully built; whitepaper evaled + benchmarked to spec; old
guardrails no longer needed gone; the "10 commandments" awayed (superseded by
the 10-atom covenant); code emerges to prod via npm AND via a GitHub open-source
client that reveals no moat/logic yet is auditable to match the whitepaper; ZK
stays moat+auth; toll-booth every dimension in a fair game-theory manner.

This plan is superpattern-shaped (CLAUDE.md). The authoritative tickable ledger
is `.claude/superpattern/covenant.walk.md`; the graph is
`.claude/superpattern/covenant.graph.json`. This file is the loop's contract.

## GOAL (north star)

The 7-truth covenant promise `when` is genuinely TRUE: the toll-booth'd covenant
CDP is built and tested, the whitepaper reflects the code, stale guardrails are
gone, and the open auditable client + npm release reproduce the whitepaper's
WHAT — with ZK/auth/route-graph moat intact and the booth split fair (no leak).
Output `<promise>SHIPPED</promise>` ONLY when all 7 acceptance gates are green
AND Lewis has authorized the two irreversible emerge nodes.

## NON-GOALS

- Not a rewrite of v6 — covenant CDP lands alongside it (feat/v7-covenant-cdp).
- Not open-sourcing the capture/RE engine, route graph, or economic constants.
- Not unfreezing the public `unbrowse-ai/unbrowse` repo (frozen by design).
- Not a one-shot benchmark headline — reproducible, two-witness, agent-judged.

## ACCEPTANCE CRITERIA (each a runnable gate — no fabricated green)

1. **Built** — `bun test tests/covenant-seed.test.ts tests/covenant-toll-ledger.test.ts` all pass; toll/meter/first-discoverer primitive real in `src/covenant-seed.ts` + `src/covenant-toll-ledger.ts`. *(verb core: DONE @ 72ee4d63b, 6/6 + 11/11)*
2. **Verb wired** — every settled resolve/execute emits a signed, never-throws toll event on the request path (additive call-site in `src/cli-v7/breath/execute.ts`); a test asserts the emission. *(open)*
3. **Speced** — `bash scripts/paper-gate.sh paper/internal-apis.tex` RC=0 (every shipped claim anchored) AND the whitepaper's benchmarked claims trace to a real bench run. *(paper-gate green; benchmark-to-spec open)*
4. **Pruned + Awayed** — stale guardrails audited and retired; load-bearing gates (leak-guard, paper-gate) kept; the "10 commandments" superseded by the 10-atom covenant, recorded. Careful: 214-file dirty tree → audit-before-delete. *(partial)*
5. **Bench** — Exa-published benchmark + BrowseComp both scored reproducibly, two-witness, agent-judged, vs target. A win widens; honest loss is reported, not hidden. *(open)*
6. **OSS auditable client** — thin transport (`@unbrowse/client`/sdk-v2) auditable to the whitepaper WHAT; `bash scripts/leak-guard.sh` RC=0 over its surface; reveals no HOW. *(leak-guard green; client-audit open)*
7. **Fair toll + ZK moat** — split sums exactly to amount (zero leak, tested); ZK credential↔wallet bind proven WITHOUT reveal (witness node, closed-source). *(split: DONE; ZK witness: open)*

## RISKS

- Editing the 291-line execute handler rushed → break the request path. Mitigate: additive, never-throws, mirror `emitExecuteReplayTrace`; test the call-site.
- Aggressive konmari in a 214-file dirty tree → lose load-bearing code. Mitigate: grep-before-delete, per-deletion verify.
- Benchmark fake-green (numbers before the scorer runs). Mitigate: agent-judged raw artifacts, two witnesses, reproducible corpus.
- Peer codex loop on `default` hijacks git HEAD. Mitigate: `ps` check each iteration; in-thread only.

## OUT-OF-SCOPE for autonomous walk — REQUIRES EXPLICIT LEWIS AUTHORIZATION

The two `emerge` nodes are irreversible + outward and the loop must NOT trigger
them autonomously:

- **emerge_npm** — `bun run release:preview` → tag → CI publish. Standing rule: never direct npm publish; all via CI; Lewis triggers.
- **emerge_oss** — public-GitHub auditable client. In tension with "public repo frozen by design." Lewis's new args resolve the DESIGN (separate thin client, whitepaper-WHAT only, no moat leak, ZK stays moat) but the outward push still needs Lewis's go.

The loop walks every reversible node to `seal` autonomously, then STOPS at this
fork. `SHIPPED` is forbidden until both (a) all 7 gates green AND (b) Lewis
authorizes the emerge nodes. Until then: do not lie, do not emit the promise.
