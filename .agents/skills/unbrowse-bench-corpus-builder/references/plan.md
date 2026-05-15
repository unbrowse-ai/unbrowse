# Day 0 Plan

## GOAL

Make it easy to add harder Unbrowse release-gate probes while preserving the rule that Codex agents judge bench artifacts in-thread.

## NON-GOALS

- No generated verdicts.
- No expected pass/fail labels in corpus rows.
- No external LLM judge.
- No browser result snapshots as proof.

## ACCEPTANCE CRITERIA

- New rows carry lane, auth, difficulty, strategy, intent, and URL.
- The corpus validator rejects malformed rows and duplicate intent plus URL pairs.
- Judge bundles expose enough evidence to answer:
  - Was the right thing indexed?
  - Was it stored?
  - Did resolve retrieve the right endpoint for the query?
  - Did execute return the requested entity?
- The deterministic scripts validate shape only.

## RISKS

- Agents may confuse regression unit tests with coverage proof.
- Corpus metadata may drift into verdict language.
- Auth and hostile probes may accidentally enter the denominator.

## OUT-OF-SCOPE

- Changing bench thresholds.
- Freezing a new baseline.
- Deciding release readiness without agent-written verdicts.
