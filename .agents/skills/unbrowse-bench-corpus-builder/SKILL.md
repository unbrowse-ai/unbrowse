---
name: unbrowse-bench-corpus-builder
description: Add harder Unbrowse release-gate bench probes as typed corpus rows. Default output is always a validated corpus patch using lane, auth, difficulty, strategy, intent, and URL metadata. Never emits PASS or FAIL verdicts.
---

# Unbrowse Bench Corpus Builder

## Output mode (load-bearing)

Default output is a validated edit to `harness/probes/corpus-gate.txt` using:

```text
lane | auth | difficulty | strategy | intent | contextUrl
```

The skill may also output a rejected candidate with the exact validation error. It never writes bench verdicts, coverage claims, or expected pass/fail outcomes.

## Workflow

1. Read `references/plan.md` for the construction goal and non-goals.
2. Classify each candidate with `references/taxonomy.md`.
3. Add the probe with:
   ```bash
   bun scripts/bench-corpus.ts add --lane <lane> --auth <auth> --difficulty <difficulty> --strategy <strategy> --intent "<intent>" --url "<url>"
   ```
4. Run:
   ```bash
   bun scripts/bench-corpus.ts validate
   ```
5. If the user asks for proof, run a small source-backed bench slice and stop at the agent judge step:
   ```bash
   LIMIT=<n> PARALLEL=4 TIMEOUT=90 bun run bench:gate:full
   ```
6. The agent reads the generated `judge.bundle.md` and writes `verdict.json`. Scripts validate shape only.

## Hard rules (gates)

1. A corpus row must include `lane`, `auth`, `difficulty`, `strategy`, `intent`, and `contextUrl`.
2. A corpus row must not include `INDEX_*`, `RETRIEVE_*`, `PASS`, or `FAIL`.
3. Duplicate `intent + contextUrl` pairs are rejected.
4. Auth-gated probes use `auth=required` and `strategy=auth-handoff`.
5. Hostile probes use `auth=blocked`, `difficulty=hostile`, and `strategy=browser-block`.
6. Coverage proof only comes from agent-written `verdict.json` over bench artifacts.

Run the local validator:

```bash
.agents/skills/unbrowse-bench-corpus-builder/scripts/validate.sh
```

## What This Skill Does NOT Do

- It does not judge whether a probe passed.
- It does not freeze baselines.
- It does not call an LLM subprocess.
- It does not replace `harness/probes/GATE_JUDGE.md`.
- It does not use frozen examples as proof of live-web behavior.

## References

- `references/plan.md` - goal, non-goals, acceptance criteria, risks.
- `references/taxonomy.md` - lane, auth, difficulty, and strategy taxonomy.
- `references/judging-contract.md` - agent-judged trace contract.
- `assets/probe-template.txt` - copyable probe row template.
