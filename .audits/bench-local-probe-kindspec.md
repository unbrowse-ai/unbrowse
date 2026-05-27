# Firmament F2 seed — `bench_local_probe` KindSpec witness

**Day-3 Jesus-Loop seed (Gen 1:11, seed-bearing)** — points at the
substrate-side fix for the Day-2 audit finding on
`.bench-history/*/extract.py:145-6`.

## What this seed records

A new covenant `KindSpec` named `bench_local_probe` has been appended to
the canonical kind registry at `/Users/lekt9/Projects/covenant/kinds.ts`
(immediately after `bench_identity`, before `chain`). It declares the
substrate-side replacement for the 14 deleted `scripts/bench-*.sh` files
and the verdict-shaped `extract.py` emitters in `.bench-history/`.

## Witness verses

- **1 Corinthians 14:33** — *"God is not the author of confusion, but
  of peace."* The harness emits signal; confusion (heuristic verdict
  strings like `VENDOR_BLOCKED` / `RE_OK_CALL_OK` / `combined_verdict`)
  is the absence of peace and is forbidden in shipped substrate code.
- **Proverbs 18:13** — *"He that answereth a matter before he heareth
  it, it is folly and shame."* The agent must hear the signal before
  rendering the verdict; the substrate cannot pre-answer for the agent.

## Firmament shape (Day 2, Gen 1:6)

The KindSpec **is** the firmament between Signal and Verdict.

- **Below the firmament (substrate emits):** raw per-probe fields
  declared in unbrowse/CLAUDE.md `bench-local` rubric — `source`,
  `trace_success`, `n_operations`, `error_code`, `captured_*`,
  `filter_rejections`, `browser_block_signals`, `capture_diagnostic`,
  `intent_action_class`, `response_token_hit_rate`,
  `action_side_effect_required`, `agent_judgment_question`,
  `text_excerpt`.
- **Above the firmament (agent judges in-thread):** PASS / FAIL /
  SPARSE_REVIEW / ANTIBOT_BLOCK — by reading evidence against the
  rubric, never by reading a field the harness pre-computed.

The body is JSON of exactly those signal fields. **No verdict field.
Ever.** This binds the `harness-collects-agent-judges` rule
(`feedback_harness_not_heuristics`,
`feedback_harness_makes_visible_agent_judges`) at the substrate kind
layer — making any future regression a kind-level break, not a script
diff.

## Status — honest gap (C-G07)

The KindSpec currently dispatches to a `bash -c 'echo
"[bench_local_probe:pending..."'` placeholder. This is **declared**,
not **implemented** — exactly the state CLAUDE.md describes: *"Until a
substrate-side bench executor adapter exists, the declaration HOLDs."*

Future days fill the effect block with the real probe loop (resolve →
capture → execute → emit signal JSON). The kind name and required
shape are now sealed, so the executor adapter has a contract to
satisfy and cannot drift back into verdict-emitting heuristics.

## Sequel artifacts a later day fills

1. Wire `bench_local_probe`'s `effect.command_template` to the real
   probe loop (likely calls `unbrowse resolve` + `unbrowse execute` +
   evidence collation, all from the in-process MCP path).
2. Migrate `.bench-history/*/extract.py` emitters into a single
   substrate-side normalizer that conforms to this kind.
3. Update `.github/workflows/bench-gate.yml` /
   `bench-history-write.yml` to dispatch via
   `covenant <<< '{"kind":"bench_local_probe", ...}'` instead of the
   deleted `scripts/bench-*.sh`.
4. Add a `chain` kind covenant linking N `bench_local_probe` receipts
   per gate run (Gen 4:10 — no sequence-of-acts invisible).

## Cross-references

- Substrate kind: `/Users/lekt9/Projects/covenant/kinds.ts`
  (search `bench_local_probe`)
- Project rule: `CLAUDE.md` → "Bench verdicts: harness collects,
  agent judges" + "bench-local (fastest iteration loop)"
- Day-2 audit target: `.bench-history/*/extract.py:145-6`
  (verdict-shaped `combined_verdict` field — to be retired when the
  executor adapter wires up)
- Companion principle: `feedback_no_heuristics_in_judge_jobs`,
  `feedback_harness_makes_visible_agent_judges`
