# recursive/ — dev harness for building unbrowse with unbrowse

This is **not** a synthetic test loop. It's a transparent observation
layer that watches the agent (you, Claude) actually use unbrowse, then
turns real friction into corpus rows + patch hints.

The agent is the probe. The harness only watches.

```
unbrowse-traced   ── transparent wrapper. agent runs THIS instead of `unbrowse`.
                     records every call to runs/<session>/calls.jsonl.
reflect.sh        ── at end of session, prints the trace so the agent can
                     judge it in-thread (per judge.md).
judge.md          ── how the agent classifies friction (issue_class +
                     smallest_patch_hint + new_probe).
corpus.txt        ── intent|url|expected_signal — the persistent memory
                     of what unbrowse must handle. Grown by reflect output.
mine-sessions.sh  ── one-shot: scan ~/.claude/.codex/.aiko jsonl for
                     historical unbrowse failures; seed corpus from real
                     past pain.
verify.sh         ── after a patch, replay only the FAIL rows from a
                     prior reflection to confirm the fix and no regressions.
runs/<session>/   ── calls.jsonl + per-call stdout/stderr files.
```

## How the recursion works

1. **Use unbrowse normally.** Just call `harness/recursive/unbrowse-traced …`
   anywhere you'd have called `unbrowse …`. Output goes to your terminal
   verbatim — UX unchanged. The wrapper records the call.
2. **At the end of the session, run `reflect.sh`.** It prints a compact
   roll-up of every call. Read it against `judge.md`.
3. **For each friction point, you (the agent) decide:**
   - `issue_class` (A1, A2, B4, C2, F2, …) per `docs/agent-experience-issues.md`
   - `smallest_patch_hint` — one concrete `file:symbol` change
   - `new_probe` — a corpus.txt row that would have caught this earlier
4. **Apply the patch.** ONE class at a time. Never `src/kuri/client.ts`.
5. **Verify.** `verify.sh <session>` replays the failing calls and you
   re-judge. PASS iff the FAILs flip and no PASSes regress.
6. **Append `new_probe` rows to corpus.txt.** Future sessions inherit
   the regression test for free.

## What "recursive" buys

- **Corpus is grown from real friction**, not human imagination — every
  row was something the agent actually struggled with.
- **Judge prompts evolve.** When a new issue class shows up, add it to
  `judge.md` so the next reflection can name it without re-deriving.
- **Patches compound.** Each verified fix becomes a permanent regression
  guarantee via the corpus row.

## Bootstrap

```bash
# alias for convenience (per shell session)
alias ub='harness/recursive/unbrowse-traced'

# work normally
ub resolve --intent "search jmail.world for elon musk" --url "https://jmail.world/?q=elon+musk"
ub execute --skill _Fwrt… --endpoint AlQL… --raw

# at end
## Anti-patterns (what we tried and rejected)

- ❌ `probe.sh` running unbrowse on a corpus in a subprocess. That replaces
  the agent instead of empowering them. Removed; banned by contract test.
- ❌ Spawning a fleet of sub-agents to drive `unbrowse-traced` for the
  main agent. Same disease in different clothes — the harness exists for
  THE AGENT IN THIS THREAD, not for an army of probes. If you find
  yourself writing "Worker N of M" prompts that call the wrapper, stop:
  you're rebuilding probe.sh out of LLMs.
- ❌ Grep-based verdicts on output. Layer 4 (judgment) is in-thread only.
- ❌ Auto-applied patches. Always human/agent gated.

## Relationship to other harnesses

- `harness/probes/` — release-gating agent-experience harness.
  This sibling is dev-time: it drives code change.
- `scripts/bench-local.sh` — coverage metric. Run AFTER a verify
  passes, to confirm no aggregate regression.
- `docs/agent-experience-issues.md` — canonical issue catalogue.
  `judge.md` references its A1/A2/B1/… codes.
